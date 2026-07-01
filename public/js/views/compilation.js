// Compilation view: cover hero, ordered song list with an emoji reaction
// control per row (community aggregate strip + a "+" picker).
// Authors and admins also get an inline "✏ Modifier" mode that exposes
// drag-to-reorder, title/artist editing, audio re-upload, and song deletion,
// plus a "🗑 Supprimer la compilation" button.

import { auth, db } from '../firebase-init.js';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  increment,
  orderBy,
  query,
  serverTimestamp,
  writeBatch,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js';
import { coverUrl, invalidateCover } from '../image-url.js';
import { doublonChipsHTML, enrichFactsHTML, paintDoublonCovers, escape } from '../track-meta.js';
import { playQueue } from '../player.js';
import { ensureCommunityReactionsLoaded } from '../community-reactions.js';
import { createReactionControl } from '../reaction-control.js';
import {
  isCompLiked,
  toggleCompLike,
  onChange as onCompLikeChange,
} from '../liked-compilations.js';
import {
  allAuthorOptions,
  authorSlug,
  displayNameFor,
  getCompilation,
  removeCompilationLocal,
} from '../catalog.js';
import { isAdminSync } from '../auth-guard.js';
import {
  deleteCompilation,
  replaceSongBinary,
  runWithConcurrency,
  uploadCover,
  uploadSong,
  recomputeDurations,
} from '../upload-pipeline.js';
import { navigate } from '../router.js';
import { avatarHTML, paintAvatars } from '../avatar.js';

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

  // Unpublished compilations are private to their author (and admins).
  if (comp.status !== 'published' && !canEdit) {
    main.innerHTML = '<div class="notice">Compilation introuvable.</div>';
    return;
  }

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
      doublons: s.doublons || null,
      // Discogs enrichment (see functions/discogs.js). Any may be absent.
      year: s.year || null,
      label: s.label || null,
      artistBio: s.artistBio || null,
      artistCountry: s.artistCountry || null,
      artistTown: s.artistTown || null,
      discogsUrl: s.discogs?.releaseUrl || null,
    };
  });

  // Mutable copy of comp.title that survives edit-mode round trips.
  let liveCompTitle = comp.title;

  let mode = 'view';
  let editState = null;
  let rxControls = [];

  function recomputeTotal() {
    return songs.reduce((a, t) => a + (t.duration || 0), 0);
  }

  async function paintHeroCover() {
    const art = main.querySelector('#hero-art');
    if (!art) return;
    if (comp.coverPath) {
      const url = await coverUrl(comp.coverPath);
      if (url) art.style.backgroundImage = `url(${url})`;
    } else {
      art.textContent = (liveCompTitle || '?')[0].toUpperCase();
    }
  }

  function renderView() {
    mode = 'view';
    editState = null;
    rxControls.forEach((c) => c.unsub());
    rxControls = [];
    const totalDur = recomputeTotal();
    main.innerHTML = `
      <div class="detail-hero">
        <div class="art ${comp.coverPath ? '' : 'placeholder'}" id="hero-art"></div>
        <div class="meta">
          <p class="eyebrow">${comp.season === 'noel' ? '❄ Noël' : '☀ Été'} ${comp.year || ''}${comp.status === 'draft' ? ' · brouillon' : ''}</p>
          <h1>${escape(liveCompTitle)}</h1>
          <div class="by">par <a class="by-link" href="/author/${authorSlug(comp.author)}">${avatarHTML(comp.author, { size: 'sm' })}<span>${escape(displayNameFor(comp.author))}</span></a></div>
          <div class="stats">${songs.length} morceau${songs.length > 1 ? 'x' : ''} · ${fmt(totalDur)}</div>
          ${comp.status === 'draft' && canEdit ? '<div class="notice" style="margin:12px 0;">Brouillon non publié — visible seulement par toi. <a href="/upload">Continuer / publier</a></div>' : ''}
          <div class="actions">
            <button class="btn-accent" id="playAll">▶ Tout écouter</button>
            <button class="btn-ghost" id="likeComp" title="J'aime cette compilation" aria-label="J'aime cette compilation">🤍 J'aime</button>
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
          <div class="tk-text">
            <div class="title">${escape(t.title)}</div>
            <div class="artist">${escape(t.artist)}</div>
            ${enrichFactsHTML(t)}
          </div>
          ${doublonChipsHTML(t.doublons, id)}
        </div>
        <span class="dur">${fmt(t.duration)}</span>
      `;
      li.addEventListener('click', (e) => {
        if (e.target.closest('.rx')) return;
        if (e.target.closest('.tk-doublons')) return;
        if (e.target.closest('.tk-info') || e.target.closest('.tk-bio')) return;
        playQueue(songs, { startIndex: i, sourceLabel: liveCompTitle });
      });
      // Bio toggle reveals/hides the artist bio inline.
      const bioToggle = li.querySelector('.tk-bio-toggle');
      if (bioToggle) {
        bioToggle.addEventListener('click', (e) => {
          e.stopPropagation();
          const bio = li.querySelector('.tk-bio');
          const show = bio.hidden;
          bio.hidden = !show;
          bioToggle.setAttribute('aria-expanded', String(show));
        });
      }
      const rx = createReactionControl(t.songId, { compact: false });
      li.querySelector('.tk-text').appendChild(rx.el);
      t.rxControl = rx;
      rxControls.push(rx);
      tracksEl.appendChild(li);
      t.li = li;
    });

    paintDoublonCovers(main);

    // Community emoji aggregate loads lazily; refresh the strips once it's in.
    ensureCommunityReactionsLoaded().then(() => rxControls.forEach((c) => c.refresh()));

    main.querySelector('#playAll').addEventListener('click', () => {
      playQueue(songs, { startIndex: 0, sourceLabel: liveCompTitle });
    });
    main.querySelector('#likeComp').addEventListener('click', () => toggleCompLike(id));
    renderCompLike();
    main.querySelector('#editBtn')?.addEventListener('click', () => renderEdit());
  }

  function renderCompLike() {
    const btn = main.querySelector('#likeComp');
    if (!btn) return;
    const liked = isCompLiked(id);
    btn.innerHTML = liked ? '❤️ Aimée' : '🤍 J\'aime';
    btn.classList.toggle('active', liked);
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
      <div class="actions" style="margin:8px 0;">
        <button class="btn-ghost" id="addTrackBtn">➕ Ajouter un morceau</button>
      </div>
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
    main.querySelector('#addTrackBtn').addEventListener('click', () => triggerAddTracks());
  }

  // Number of uploads still in flight. While > 0 we disable Save/Cancel so the
  // user can't tear down editState out from under a running upload task.
  let addUploads = 0;
  function setAddBusy(delta) {
    addUploads += delta;
    const busy = addUploads > 0;
    const addBtn = main.querySelector('#addTrackBtn');
    const saveBtn = main.querySelector('#saveEdit');
    const cancelBtn = main.querySelector('#cancelEdit');
    if (addBtn) { addBtn.disabled = busy; addBtn.textContent = busy ? 'Ajout en cours…' : '➕ Ajouter un morceau'; }
    if (saveBtn) saveBtn.disabled = busy;
    if (cancelBtn) cancelBtn.disabled = busy;
  }

  // Open a file picker and append the chosen audio files as new tracks. Each
  // file goes through the same uploadSong → processSong pipeline as the initial
  // upload; the created song doc is appended at the end of the tracklist. Adds
  // are persisted immediately (like the 🔄 replace button), then finalized on
  // Save alongside any reordering/renaming.
  function triggerAddTracks() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/mpeg,audio/mp4,audio/flac,audio/aiff,audio/wav,audio/ogg,.mp3,.m4a,.flac,.aiff,.aif,.wav,.ogg';
    input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const files = [...(input.files || [])];
      input.remove();
      if (files.length) addTrackFiles(files);
    });
    input.click();
  }

  async function addTrackFiles(files) {
    const list = main.querySelector('#edTracks');
    // Insert a pending placeholder row per file so the user sees progress.
    const pending = files.map((file) => {
      const row = {
        songId: null,
        order: 0,
        title: file.name.replace(/\.[^.]+$/, ''),
        artist: '',
        duration: 0,
        deleted: false,
        uploading: true,
        progress: 0,
      };
      editState.rows.push(row);
      return { file, row };
    });
    renderEditRows(list);
    setAddBusy(+1);

    const tasks = pending.map(({ file, row }) => async () => {
      // Append at the end of the currently-live rows.
      const order = editState.rows.filter((r) => !r.deleted).indexOf(row);
      try {
        const result = await uploadSong({
          file,
          compilationId: id,
          order,
          onProgress: (p) => { row.progress = p; updateRowProgress(row); },
        });
        row.songId = result.songId;
        row.title = result.title || row.title;
        row.artist = result.artist || '';
        row.duration = result.duration || 0;
        row.order = order;
        row.uploading = false;

        // Pull the full song doc so the new track is immediately playable
        // (needs storagePath) after Save without reloading the page.
        const snap = await getDoc(doc(db, 'compilations', id, 'songs', result.songId));
        const s = snap.exists() ? snap.data() : {};
        songs.push({
          songId: result.songId,
          order,
          title: row.title || 'Sans titre',
          artist: row.artist,
          duration: row.duration,
          storagePath: s.storagePath,
          compilationId: comp.id,
          compilationTitle: comp.title,
          coverPath: comp.coverPath || null,
          doublons: s.doublons || null,
          year: s.year || null,
          label: s.label || null,
          artistBio: s.artistBio || null,
          artistCountry: s.artistCountry || null,
          artistTown: s.artistTown || null,
          discogsUrl: s.discogs?.releaseUrl || null,
        });
      } catch (err) {
        const idx = editState.rows.indexOf(row);
        if (idx >= 0) editState.rows.splice(idx, 1);
        showEditError(`Échec de l'ajout de « ${file.name} » : ${err.message || err}`);
      }
    });

    await runWithConcurrency(tasks, 3);

    // processSong already bumped the compilation's counters server-side; mirror
    // that into the shared in-memory catalog object so listings stay in sync.
    comp.trackCount = songs.length;
    comp.totalDuration = recomputeTotal();

    setAddBusy(-1);
    renderEditRows(list);
    updateStats();
  }

  function updateRowProgress(row) {
    const fill = row._li?.querySelector('.ed-progress span');
    if (fill) fill.style.width = `${Math.round((row.progress || 0) * 100)}%`;
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
        // The cover changed: drop the cached URL so every other view re-resolves
        // the fresh (rotated-token) one. Repaint the hero now, cache-busting the
        // bytes since the path may stay identical when overwriting the same ext.
        invalidateCover(comp.coverPath);
        const art = main.querySelector('#hero-art');
        if (art) {
          art.classList.remove('placeholder');
          art.textContent = '';
          const url = await coverUrl(comp.coverPath);
          if (url) art.style.backgroundImage = `url(${url}#${Date.now()})`;
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
      li.draggable = !r.uploading;
      li.dataset.idx = i;
      li.className = [r.deleted ? 'deleted' : '', r.uploading ? 'uploading' : ''].filter(Boolean).join(' ');
      li.innerHTML = `
        <span class="grip" title="Glisser pour réordonner">⋮⋮</span>
        <div class="ed-fields">
          <input class="ed-title" placeholder="Titre" value="${escape(r.title)}" ${r.uploading ? 'disabled' : ''}>
          <input class="ed-artist" placeholder="Artiste" value="${escape(r.artist)}" ${r.uploading ? 'disabled' : ''}>
        </div>
        <div class="ed-actions">
          ${r.uploading ? '' : `
          <button class="ed-replace" title="Remplacer l'audio" aria-label="Remplacer l'audio">🔄</button>
          <button class="ed-delete" title="Supprimer" aria-label="Supprimer">🗑</button>
          ${r.deleted ? '<a href="#" class="ed-undo">annuler</a>' : ''}`}
        </div>
        <span class="dur">${r.uploading ? '…' : fmt(r.duration)}</span>
        <div class="ed-progress" ${r.uploading ? '' : 'hidden'}><span style="width:${Math.round((r.progress || 0) * 100)}%"></span></div>
      `;
      r._li = li;

      // Pending upload rows have no editable controls until they land.
      if (r.uploading) { list.appendChild(li); return; }

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
    input.accept = 'audio/mpeg,audio/mp4,audio/flac,audio/aiff,audio/wav,audio/ogg,.mp3,.m4a,.flac,.aiff,.aif,.wav,.ogg';
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
      removeCompilationLocal(id);
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

      // Compute new order for the surviving rows. (A row always has a songId
      // here — added tracks are persisted before Save, and Save is disabled
      // while any upload is still in flight — but guard defensively.)
      const surviving = editState.rows.filter((r) => !r.deleted && r.songId);
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

      // Repair any stored durations an older transcode got wrong (the server
      // re-muxes the binaries and returns corrected per-song durations). Use
      // those when re-rendering. Non-fatal: a failure just leaves the originals.
      let fixedDurations = null;
      try {
        const res = await recomputeDurations(id);
        fixedDurations = res?.durations || null;
      } catch (e) {
        console.warn('recomputeDurations failed (non-fatal):', e);
      }

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
          duration: fixedDurations?.[r.songId] ?? r.duration,
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
  const unsubCompLike = onCompLikeChange((compId) => { if (compId === id) renderCompLike(); });
  return () => { rxControls.forEach((c) => c.unsub()); unsubCompLike(); };
}
