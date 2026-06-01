// Compilation view: cover hero, ordered song list with ❤️/😬 buttons per row.
// Authors and admins also get an inline "✏ Modifier" mode that exposes
// drag-to-reorder, title/artist editing, audio re-upload, and song deletion,
// plus a "🗑 Supprimer la compilation" button.

import { auth, db, storage } from '../firebase-init.js';
import {
  collection,
  doc,
  getDocs,
  increment,
  orderBy,
  query,
  serverTimestamp,
  writeBatch,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js';
import {
  ref as storageRef,
  getDownloadURL,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-storage.js';
import { playQueue } from '../player.js';
import {
  getReaction,
  toggleLike,
  toggleDislike,
  onChange as onReactionChange,
} from '../reactions.js';
import {
  allAuthorOptions,
  authorSlug,
  displayNameFor,
  getCompilation,
} from '../catalog.js';
import { isAdminSync } from '../auth-guard.js';
import { deleteCompilation, replaceSongBinary, uploadCover } from '../upload-pipeline.js';
import { navigate } from '../router.js';
import { avatarHTML, paintAvatars } from '../avatar.js';

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function fmt(s) {
  return isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '';
}

export async function mount(el, { params }) {
  const id = params.id;
  el.innerHTML = `<div class="shell" id="main"></div>`;
  const main = el.querySelector('#main');

  if (!id) {
    main.innerHTML = '<div class="notice">Aucun identifiant de compilation.</div>';
    return;
  }
  const comp = getCompilation(id);
  if (!comp) {
    main.innerHTML = '<div class="notice">Compilation introuvable.</div>';
    return;
  }

  const user = auth.currentUser;
  const emailKey = user.email.toLowerCase();
  const canEdit = comp.author === emailKey || isAdminSync(user.email);

  const songsSnap = await getDocs(query(collection(db, 'compilations', id, 'songs'), orderBy('order', 'asc')));
  let songs = songsSnap.docs.map((d) => {
    const s = d.data();
    return {
      songId: d.id,
      order: s.order,
      title: s.title || 'Sans titre',
      artist: s.artist || '',
      duration: s.duration || 0,
      storagePath: s.storagePath,
      compilationId: comp.id,
      compilationTitle: comp.title,
      coverPath: comp.coverPath || null,
    };
  });

  // Mutable copy of comp.title that survives edit-mode round trips.
  let liveCompTitle = comp.title;

  let mode = 'view';
  let editState = null;

  function recomputeTotal() {
    return songs.reduce((a, t) => a + (t.duration || 0), 0);
  }

  async function paintHeroCover() {
    const art = main.querySelector('#hero-art');
    if (!art) return;
    if (comp.coverPath) {
      try {
        const url = await getDownloadURL(storageRef(storage, comp.coverPath));
        art.style.backgroundImage = `url(${url})`;
      } catch (_) { /* ignore */ }
    } else {
      art.textContent = (liveCompTitle || '?')[0].toUpperCase();
    }
  }

  function renderView() {
    mode = 'view';
    editState = null;
    const totalDur = recomputeTotal();
    main.innerHTML = `
      <div class="detail-hero">
        <div class="art ${comp.coverPath ? '' : 'placeholder'}" id="hero-art"></div>
        <div class="meta">
          <p class="eyebrow">${comp.season === 'noel' ? '❄ Noël' : '☀ Été'} ${comp.year || ''}</p>
          <h1>${escape(liveCompTitle)}</h1>
          <div class="by">par <a class="by-link" href="/author/${authorSlug(comp.author)}">${avatarHTML(comp.author, { size: 'sm' })}<span>${escape(displayNameFor(comp.author))}</span></a></div>
          <div class="stats">${songs.length} morceau${songs.length > 1 ? 'x' : ''} · ${fmt(totalDur)}</div>
          <div class="actions">
            <button class="btn-accent" id="playAll">▶ Tout écouter</button>
            ${canEdit ? '<button class="btn-ghost" id="editBtn">✏ Modifier</button>' : ''}
          </div>
        </div>
      </div>
      <ol class="tracklist" id="tracks"></ol>
    `;
    paintHeroCover();
    paintAvatars(main);

    const tracksEl = main.querySelector('#tracks');
    songs.forEach((t, i) => {
      const li = document.createElement('li');
      li.dataset.songId = t.songId;
      li.innerHTML = `
        <span class="num">${i + 1}</span>
        <div class="tk-meta">
          <div class="title">${escape(t.title)}</div>
          <div class="artist">${escape(t.artist)}</div>
        </div>
        <div class="tk-react">
          <button class="rx-like" title="J'aime" aria-label="J'aime">🤍</button>
          <button class="rx-dis" title="Je n'aime pas" aria-label="Je n'aime pas">😬</button>
        </div>
        <span class="dur">${fmt(t.duration)}</span>
      `;
      li.addEventListener('click', (e) => {
        if (e.target.closest('.tk-react')) return;
        playQueue(songs, { startIndex: i, sourceLabel: liveCompTitle });
      });
      li.querySelector('.rx-like').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleLike(t.songId);
      });
      li.querySelector('.rx-dis').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleDislike(t.songId);
      });
      tracksEl.appendChild(li);
      t.li = li;
      renderRowReactions(t.songId);
    });

    main.querySelector('#playAll').addEventListener('click', () => {
      playQueue(songs, { startIndex: 0, sourceLabel: liveCompTitle });
    });
    main.querySelector('#editBtn')?.addEventListener('click', () => renderEdit());
  }

  function renderRowReactions(songId) {
    const tracksEl = main.querySelector('#tracks');
    if (!tracksEl) return;
    const li = tracksEl.querySelector(`li[data-song-id="${songId}"]`);
    if (!li) return;
    const r = getReaction(songId);
    const like = li.querySelector('.rx-like');
    const dis = li.querySelector('.rx-dis');
    if (!like || !dis) return;
    like.textContent = r === 'like' ? '❤️' : '🤍';
    like.classList.toggle('active', r === 'like');
    dis.classList.toggle('active', r === 'dislike');
  }

  function renderEdit() {
    mode = 'edit';
    const isAdmin = isAdminSync(user.email);
    // Snapshot current state — Cancel restores it.
    editState = {
      title: liveCompTitle,
      author: comp.author || '',
      rows: songs.map((t) => ({
        songId: t.songId,
        order: t.order,
        title: t.title,
        artist: t.artist,
        duration: t.duration,
        deleted: false,
      })),
    };

    // Admin-only author dropdown. Options union /users (signed-in) and
    // /allowlist (allowlisted but not yet signed in). Current author is
    // pre-selected by email; if it doesn't match anyone we show a
    // "(hors liste)" placeholder so the current value is still visible.
    const authorList = allAuthorOptions();
    const currentInList = editState.author && authorList.some((u) => u.email === editState.author);
    const authorBlock = isAdmin
      ? `
        <label for="edAuthor" style="margin-top:8px;">Auteur</label>
        <select id="edAuthor">
          ${!currentInList && editState.author ? `<option value="${escape(editState.author)}" selected>${escape(editState.author)} (hors liste)</option>` : ''}
          ${authorList.map((u) => `<option value="${escape(u.email)}" ${u.email === editState.author ? 'selected' : ''}>${escape(u.displayName)}${u.linked ? '' : ' (en attente)'}</option>`).join('')}
        </select>
      `
      : `<div class="by" style="margin-top:8px;">par ${escape(displayNameFor(comp.author))}</div>`;

    main.innerHTML = `
      <div class="detail-hero edit-mode">
        <div class="art ${comp.coverPath ? '' : 'placeholder'}" id="hero-art"></div>
        <div class="meta">
          <p class="eyebrow">${comp.season === 'noel' ? '❄ Noël' : '☀ Été'} ${comp.year || ''}</p>
          <label for="edTitle" style="margin-top:8px;">Titre de la compilation</label>
          <input id="edTitle" value="${escape(editState.title)}">
          ${authorBlock}
          <div class="stats" id="edStats"></div>
          <div class="actions" style="margin-top:8px;">
            <button class="btn-ghost" id="changeCoverBtn">🖼 Changer la pochette</button>
          </div>
          <div class="actions edit-actions">
            <button class="btn-ghost" id="cancelEdit">Annuler</button>
            <button class="btn-accent" id="saveEdit">Enregistrer</button>
          </div>
          <div class="actions" style="margin-top:24px;">
            <button class="btn-ghost danger" id="deleteCompBtn">🗑 Supprimer la compilation</button>
          </div>
        </div>
      </div>
      <div id="edError" class="error" hidden></div>
      <ol class="tracklist edit" id="edTracks"></ol>
    `;
    paintHeroCover();

    if (isAdmin) {
      main.querySelector('#edAuthor').addEventListener('change', (e) => {
        editState.author = e.target.value.toLowerCase();
      });
    }

    main.querySelector('#edTitle').addEventListener('input', (e) => {
      editState.title = e.target.value;
    });

    const list = main.querySelector('#edTracks');
    renderEditRows(list);

    main.querySelector('#cancelEdit').addEventListener('click', () => renderView());
    main.querySelector('#saveEdit').addEventListener('click', () => saveEdit());
    main.querySelector('#deleteCompBtn').addEventListener('click', () => deleteCurrentCompilation());
    main.querySelector('#changeCoverBtn').addEventListener('click', () => triggerCoverChange());
  }

  function triggerCoverChange() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      const btn = main.querySelector('#changeCoverBtn');
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Envoi…';
      try {
        const result = await uploadCover({ file, compilationId: id });
        comp.coverPath = result.coverPath;
        // Repaint hero; cache-bust the URL because the storage path may stay
        // identical when overwriting the same extension and browsers will keep
        // the stale image otherwise.
        const art = main.querySelector('#hero-art');
        if (art) {
          art.classList.remove('placeholder');
          art.textContent = '';
          const url = await getDownloadURL(storageRef(storage, comp.coverPath));
          art.style.backgroundImage = `url(${url}#${Date.now()})`;
        }
      } catch (err) {
        showEditError(`Échec du changement de pochette : ${err.message || err}`);
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    });
    input.click();
  }

  function renderEditRows(list) {
    list.innerHTML = '';
    editState.rows.forEach((r, i) => {
      const li = document.createElement('li');
      li.draggable = true;
      li.dataset.idx = i;
      li.className = r.deleted ? 'deleted' : '';
      li.innerHTML = `
        <span class="grip" title="Glisser pour réordonner">⋮⋮</span>
        <div class="ed-fields">
          <input class="ed-title" placeholder="Titre" value="${escape(r.title)}">
          <input class="ed-artist" placeholder="Artiste" value="${escape(r.artist)}">
        </div>
        <div class="ed-actions">
          <button class="ed-replace" title="Remplacer l'audio" aria-label="Remplacer l'audio">🔄</button>
          <button class="ed-delete" title="Supprimer" aria-label="Supprimer">🗑</button>
          ${r.deleted ? '<a href="#" class="ed-undo">annuler</a>' : ''}
        </div>
        <span class="dur">${fmt(r.duration)}</span>
        <div class="ed-progress" hidden><span></span></div>
      `;
      li.querySelector('.ed-title').addEventListener('input', (e) => { r.title = e.target.value; });
      li.querySelector('.ed-artist').addEventListener('input', (e) => { r.artist = e.target.value; });
      li.querySelector('.ed-delete').addEventListener('click', () => {
        r.deleted = true;
        renderEditRows(list);
        updateStats();
      });
      li.querySelector('.ed-undo')?.addEventListener('click', (e) => {
        e.preventDefault();
        r.deleted = false;
        renderEditRows(list);
        updateStats();
      });
      li.querySelector('.ed-replace').addEventListener('click', () => triggerReplace(r, li));

      // Drag-and-drop reorder
      li.addEventListener('dragstart', (e) => { li.classList.add('dragging'); e.dataTransfer.setData('text/plain', i); });
      li.addEventListener('dragend', () => li.classList.remove('dragging'));
      li.addEventListener('dragover', (e) => e.preventDefault());
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        const from = +e.dataTransfer.getData('text/plain');
        const to = +li.dataset.idx;
        if (from === to) return;
        const moved = editState.rows.splice(from, 1)[0];
        editState.rows.splice(to, 0, moved);
        renderEditRows(list);
      });
      list.appendChild(li);
    });
    updateStats();
  }

  function updateStats() {
    const statsEl = main.querySelector('#edStats');
    if (!statsEl) return;
    const live = editState.rows.filter((r) => !r.deleted);
    const total = live.reduce((a, r) => a + (r.duration || 0), 0);
    statsEl.textContent = `${live.length} morceau${live.length > 1 ? 'x' : ''} · ${fmt(total)}`;
  }

  function triggerReplace(row, li) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/mpeg,.mp3';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      const progressBar = li.querySelector('.ed-progress');
      const progressFill = progressBar.querySelector('span');
      progressBar.hidden = false;
      try {
        const result = await replaceSongBinary({
          file,
          compilationId: id,
          songId: row.songId,
          onProgress: (p) => { progressFill.style.width = `${(p * 100).toFixed(0)}%`; },
        });
        row.duration = result.duration || 0;
        const liveT = songs.find((t) => t.songId === row.songId);
        if (liveT) liveT.duration = result.duration || 0;
        progressBar.hidden = true;
        li.querySelector('.dur').textContent = fmt(row.duration);
        updateStats();
      } catch (err) {
        progressBar.hidden = true;
        showEditError(`Échec du remplacement : ${err.message || err}`);
      }
    });
    input.click();
  }

  function showEditError(msg) {
    const errEl = main.querySelector('#edError');
    if (!errEl) return;
    errEl.textContent = msg;
    errEl.hidden = false;
  }

  async function deleteCurrentCompilation() {
    if (!confirm(`Supprimer définitivement « ${liveCompTitle} » et tous ses morceaux ?`)) return;
    const btn = main.querySelector('#deleteCompBtn');
    btn.disabled = true;
    btn.textContent = 'Suppression…';
    try {
      await deleteCompilation(id);
      navigate('/');
    } catch (err) {
      console.error('deleteCompilation', err);
      showEditError(`Échec de la suppression : ${err.message || err}`);
      btn.disabled = false;
      btn.textContent = '🗑 Supprimer la compilation';
    }
  }

  async function saveEdit() {
    const saveBtn = main.querySelector('#saveEdit');
    const cancelBtn = main.querySelector('#cancelEdit');
    saveBtn.disabled = true; cancelBtn.disabled = true;
    saveBtn.textContent = 'Enregistrement…';
    try {
      const batch = writeBatch(db);
      const compRef = doc(db, 'compilations', id);
      const trimmedTitle = (editState.title || '').trim();

      // Compilation title diff
      if (trimmedTitle && trimmedTitle !== comp.title) {
        batch.update(compRef, { title: trimmedTitle, updatedAt: serverTimestamp() });
      }

      // Author reassignment (admin only — the dropdown isn't rendered for
      // non-admins so editState.author stays at its initial value).
      if (editState.author && editState.author !== comp.author) {
        batch.update(compRef, {
          author: editState.author,
          updatedAt: serverTimestamp(),
        });
      }

      // Compute new order for the surviving rows.
      const surviving = editState.rows.filter((r) => !r.deleted);
      let deletedDurationTotal = 0;
      let deletedCount = 0;

      surviving.forEach((r, i) => {
        const original = songs.find((t) => t.songId === r.songId);
        const songRef = doc(db, 'compilations', id, 'songs', r.songId);
        const update = {};
        if (original.order !== i) update.order = i;
        if ((r.title || '') !== (original.title || '')) update.title = r.title || null;
        if ((r.artist || '') !== (original.artist || '')) update.artist = r.artist || null;
        if (Object.keys(update).length > 0) {
          update.updatedAt = serverTimestamp();
          batch.update(songRef, update);
        }
      });

      editState.rows
        .filter((r) => r.deleted)
        .forEach((r) => {
          batch.delete(doc(db, 'compilations', id, 'songs', r.songId));
          deletedDurationTotal += r.duration || 0;
          deletedCount += 1;
        });

      if (deletedCount > 0) {
        batch.update(compRef, {
          trackCount: increment(-deletedCount),
          totalDuration: increment(-deletedDurationTotal),
          updatedAt: serverTimestamp(),
        });
      }

      await batch.commit();

      // Apply changes locally so we can stay on the page without a reload.
      if (trimmedTitle && trimmedTitle !== comp.title) {
        comp.title = trimmedTitle;
        liveCompTitle = trimmedTitle;
      }
      if (editState.author && editState.author !== comp.author) {
        comp.author = editState.author;
      }
      songs = surviving.map((r, i) => {
        const original = songs.find((t) => t.songId === r.songId);
        return {
          ...original,
          order: i,
          title: r.title || 'Sans titre',
          artist: r.artist || '',
          duration: r.duration,
        };
      });

      renderView();
    } catch (err) {
      console.error('saveEdit', err);
      showEditError(`Échec de l'enregistrement : ${err.message || err}`);
      saveBtn.disabled = false; cancelBtn.disabled = false;
      saveBtn.textContent = 'Enregistrer';
    }
  }

  renderView();
  const unsub = onReactionChange((songId) => renderRowReactions(songId));
  return () => unsub();
}
