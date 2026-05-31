// Compilation view: cover hero, ordered track list with ❤️/💩 buttons per row.
// Authors and admins also get an inline "✏ Modifier" mode that exposes
// drag-to-reorder, title/artist editing, audio re-upload, and track deletion.

import { auth, db, storage } from '../firebase-init.js';
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  increment,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
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
import { allAssignableUsers, getAssignable, getCompilation, getSong, getUser } from '../catalog.js';
import { isAdminSync } from '../auth-guard.js';
import { replaceSongBinary } from '../upload-pipeline.js';
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
  const canEdit = comp.authorUid === user.uid || isAdminSync(user.email);

  const tracksSnap = await getDocs(query(collection(db, 'compilations', id, 'tracks'), orderBy('order', 'asc')));
  // Track shape: keep the raw track-row override values (overrideTitle/Artist)
  // separately from the display values (which fall back to the song doc), so
  // edit mode can show whether a custom override exists.
  let tracks = tracksSnap.docs.map((d) => {
    const t = d.data();
    const s = getSong(t.songId) || {};
    return {
      trackId: d.id,
      songId: t.songId,
      order: t.order,
      overrideTitle: t.title || '',
      overrideArtist: t.artist || '',
      title: t.title || s.title || 'Sans titre',
      artist: t.artist || s.artist || '',
      duration: t.duration || s.duration || 0,
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
    return tracks.reduce((a, t) => a + (t.duration || 0), 0);
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
          <div class="by">par <a class="by-link" href="/author/${encodeURIComponent(comp.authorName)}">${avatarHTML(comp.authorName, { size: 'sm' })}<span>${escape(getUser(comp.authorUid)?.displayName || comp.authorName)}</span></a></div>
          <div class="stats">${tracks.length} morceau${tracks.length > 1 ? 'x' : ''} · ${fmt(totalDur)}</div>
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
    tracks.forEach((t, i) => {
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
          <button class="rx-dis" title="Je n'aime pas" aria-label="Je n'aime pas">💩</button>
        </div>
        <span class="dur">${fmt(t.duration)}</span>
      `;
      li.addEventListener('click', (e) => {
        if (e.target.closest('.tk-react')) return;
        playQueue(tracks, { startIndex: i, sourceLabel: liveCompTitle });
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
      playQueue(tracks, { startIndex: 0, sourceLabel: liveCompTitle });
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
    const initialKey = (getUser(comp.authorUid)?.email || comp.authorName || '').toLowerCase();
    editState = {
      title: liveCompTitle,
      authorKey: initialKey,
      authorUid: comp.authorUid || '',
      authorName: comp.authorName || '',
      rows: tracks.map((t) => ({
        trackId: t.trackId,
        songId: t.songId,
        order: t.order,
        overrideTitle: t.overrideTitle,
        overrideArtist: t.overrideArtist,
        duration: t.duration,
        deleted: false,
      })),
    };

    // Admin-only author dropdown. Options union /users (signed-in) and
    // /allowlist (allowlisted but not yet signed in). Current author is
    // pre-selected by email key; if it doesn't match anyone we show a
    // "(hors liste)" placeholder so the current value is still visible.
    const assignableList = allAssignableUsers();
    const currentInList = editState.authorKey && assignableList.some((u) => u.key === editState.authorKey);
    const authorBlock = isAdmin
      ? `
        <label for="edAuthor" style="margin-top:8px;">Auteur</label>
        <select id="edAuthor">
          ${!currentInList && (editState.authorKey || editState.authorName) ? `<option value="" selected>${escape(editState.authorName || editState.authorKey)} (hors liste)</option>` : ''}
          ${assignableList.map((u) => `<option value="${escape(u.key)}" ${u.key === editState.authorKey ? 'selected' : ''}>${escape(u.displayName || u.email || u.key)}${u.linked ? '' : ' (en attente)'}</option>`).join('')}
        </select>
      `
      : `<div class="by" style="margin-top:8px;">par ${escape(getUser(comp.authorUid)?.displayName || comp.authorName)}</div>`;

    main.innerHTML = `
      <div class="detail-hero edit-mode">
        <div class="art ${comp.coverPath ? '' : 'placeholder'}" id="hero-art"></div>
        <div class="meta">
          <p class="eyebrow">${comp.season === 'noel' ? '❄ Noël' : '☀ Été'} ${comp.year || ''}</p>
          <label for="edTitle" style="margin-top:8px;">Titre de la compilation</label>
          <input id="edTitle" value="${escape(editState.title)}">
          ${authorBlock}
          <div class="stats" id="edStats"></div>
          <div class="actions edit-actions">
            <button class="btn-ghost" id="cancelEdit">Annuler</button>
            <button class="btn-accent" id="saveEdit">Enregistrer</button>
          </div>
        </div>
      </div>
      <div id="edError" class="error" hidden></div>
      <ol class="tracklist edit" id="edTracks"></ol>
    `;
    paintHeroCover();

    if (isAdmin) {
      main.querySelector('#edAuthor').addEventListener('change', (e) => {
        const picked = getAssignable(e.target.value);
        editState.authorKey = e.target.value;
        editState.authorUid = picked?.uid || '';
        editState.authorName = picked?.displayName || picked?.email || editState.authorName;
      });
    }

    main.querySelector('#edTitle').addEventListener('input', (e) => {
      editState.title = e.target.value;
    });

    const list = main.querySelector('#edTracks');
    renderEditRows(list);

    main.querySelector('#cancelEdit').addEventListener('click', () => renderView());
    main.querySelector('#saveEdit').addEventListener('click', () => saveEdit());
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
          <input class="ed-title" placeholder="Titre" value="${escape(r.overrideTitle)}">
          <input class="ed-artist" placeholder="Artiste" value="${escape(r.overrideArtist)}">
        </div>
        <div class="ed-actions">
          <button class="ed-replace" title="Remplacer l'audio" aria-label="Remplacer l'audio">🔄</button>
          <button class="ed-delete" title="Supprimer" aria-label="Supprimer">🗑</button>
          ${r.deleted ? '<a href="#" class="ed-undo">annuler</a>' : ''}
        </div>
        <span class="dur">${fmt(r.duration)}</span>
        <div class="ed-progress" hidden><span></span></div>
      `;
      li.querySelector('.ed-title').addEventListener('input', (e) => { r.overrideTitle = e.target.value; });
      li.querySelector('.ed-artist').addEventListener('input', (e) => { r.overrideArtist = e.target.value; });
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
          trackId: row.trackId,
          onProgress: (p) => { progressFill.style.width = `${(p * 100).toFixed(0)}%`; },
        });
        // Reflect new songId/duration locally; the live `tracks` array will be
        // refreshed from Firestore on next view-mode render. For now, update
        // editState so the UI keeps showing accurate duration.
        row.songId = result.songId;
        row.duration = result.duration || 0;
        // Also update the live tracks entry (used by view mode) so things stay
        // coherent if the user toggles back without saving.
        const liveT = tracks.find((t) => t.trackId === row.trackId);
        if (liveT) {
          liveT.songId = result.songId;
          liveT.duration = result.duration || 0;
        }
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
      // non-admins so editState.authorKey stays at its initial value).
      // authorUid may be '' when admin picked an allowlist-only entry whose
      // assignee hasn't signed in yet; rules permit non-self authorUid for
      // admins, so the write is accepted.
      const initialKey = (getUser(comp.authorUid)?.email || comp.authorName || '').toLowerCase();
      if (editState.authorKey && editState.authorKey !== initialKey) {
        batch.update(compRef, {
          authorUid: editState.authorUid,
          authorName: editState.authorName,
          updatedAt: serverTimestamp(),
        });
      }

      // Compute new order for the surviving rows.
      const surviving = editState.rows.filter((r) => !r.deleted);
      let deletedDurationTotal = 0;
      let deletedCount = 0;

      surviving.forEach((r, i) => {
        const original = tracks.find((t) => t.trackId === r.trackId);
        const trackRef = doc(db, 'compilations', id, 'tracks', r.trackId);
        const update = {};
        if (original.order !== i) update.order = i;
        if ((r.overrideTitle || '') !== (original.overrideTitle || '')) update.title = r.overrideTitle || null;
        if ((r.overrideArtist || '') !== (original.overrideArtist || '')) update.artist = r.overrideArtist || null;
        if (Object.keys(update).length > 0) {
          update.updatedAt = serverTimestamp();
          batch.update(trackRef, update);
        }
      });

      editState.rows
        .filter((r) => r.deleted)
        .forEach((r) => {
          batch.delete(doc(db, 'compilations', id, 'tracks', r.trackId));
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
      if (editState.authorKey && editState.authorKey !== initialKey) {
        comp.authorUid = editState.authorUid;
        comp.authorName = editState.authorName;
      }
      tracks = surviving.map((r, i) => {
        const original = tracks.find((t) => t.trackId === r.trackId);
        const s = getSong(r.songId) || {};
        return {
          ...original,
          songId: r.songId,
          order: i,
          overrideTitle: r.overrideTitle,
          overrideArtist: r.overrideArtist,
          title: r.overrideTitle || s.title || 'Sans titre',
          artist: r.overrideArtist || s.artist || '',
          duration: r.duration,
          storagePath: s.storagePath || original.storagePath,
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
