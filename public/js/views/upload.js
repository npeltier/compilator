// Upload view: build the current season's compilation. A compilation lives as a
// `draft` (songs uploaded, editable, returnable-to) until the author hits
// "Publier", which flips it to `published`.
//
// One author may only have ONE compilation per season/year: on mount we look up
// the author's existing compilation for the slot and continue editing it instead
// of creating a second. If it's already published, we send them to it.

import { auth, db } from '../firebase-init.js';
import { uploadSong, uploadCover, runWithConcurrency } from '../upload-pipeline.js';
import { nextCompilationSlot, slotLabel, deadlineLabel } from '../slot.js';
import { navigate } from '../router.js';
import { allCompilations, displayNameFor, upsertCompilationLocal } from '../catalog.js';
import { coverUrl, invalidateCover } from '../image-url.js';
import {
  addDoc,
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  writeBatch,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js';
import { parseBlob } from 'https://cdn.jsdelivr.net/npm/music-metadata-browser@2.5.10/+esm';

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function fmtDur(s) {
  if (!s || !isFinite(s)) return '';
  const m = Math.floor(s / 60); const r = Math.round(s % 60);
  return `${m}:${r.toString().padStart(2, '0')}`;
}

const STATUS_LABEL = { uploaded: 'enregistré', pending: 'à envoyer', uploading: 'envoi…', done: 'ok', error: 'erreur', dup: 'doublon' };

export async function mount(el) {
  const user = auth.currentUser;
  const emailKey = user.email.toLowerCase();
  const myDisplayName = displayNameFor(emailKey);
  const slot = nextCompilationSlot();

  // One compilation per author per season: reuse the existing one if there is one.
  const existing = allCompilations().find(
    (c) => c.author === emailKey && c.season === slot.season && c.year === slot.year,
  );

  // Already published this season → can't make a second; point them to it.
  if (existing && existing.status === 'published') {
    el.innerHTML = `
      <div class="shell-narrow">
        <p class="eyebrow">Prochaine compil — ${slotLabel(slot)}</p>
        <h1>Déjà publiée.</h1>
        <p class="notice">Tu as déjà publié une compilation pour ${slotLabel(slot)} :
          <strong>${escape(existing.title)}</strong>. Une seule par saison !</p>
        <div style="margin-top:24px;"><a class="btn-accent" href="/c/${existing.id}">Voir / modifier</a></div>
      </div>
    `;
    return;
  }

  // compId is set once the draft exists in Firestore (existing draft, or created on first save).
  let compId = existing ? existing.id : null;
  let coverPath = existing ? (existing.coverPath || null) : null;

  // The working list: existing (already-uploaded) songs + new (pending) files.
  // `removed` marks an existing song for deletion on save (with undo).
  const items = [];
  if (compId) {
    const snap = await getDocs(query(collection(db, 'compilations', compId, 'songs'), orderBy('order', 'asc')));
    snap.forEach((d) => {
      const s = d.data();
      items.push({
        kind: 'existing', songId: d.id, removed: false,
        title: s.title || 'Sans titre', artist: s.artist || '', duration: s.duration || 0,
        status: 'uploaded',
      });
    });
  }

  el.innerHTML = `
    <div class="shell-narrow">
      <p class="eyebrow">Prochaine compil — ${slotLabel(slot)} · à rendre avant le ${deadlineLabel(slot)}</p>
      <h1>Fais ton disque.</h1>
      ${compId ? '<p class="notice">Brouillon en cours — ajoute des morceaux, enregistre, et publie quand tu es prêt.</p>' : ''}

      <div id="error" class="error" hidden></div>
      <div id="ok" class="notice" hidden></div>

      <section class="section">
        <h3>Détails</h3>
        <label for="title">Titre</label>
        <input id="title" placeholder="ex. Christmousse" required value="${existing ? escape(existing.title) : ''}">
        <p style="color:var(--ink-faint);font-size:12px;margin-top:6px;">
          Auteur : <strong>${escape(myDisplayName)}</strong> (modifiable depuis ton profil).
        </p>
      </section>

      <section class="section">
        <h3>Pochette</h3>
        <p class="notice">Optionnel — sans pochette, l'image embarquée dans la balise ID3 du premier morceau sera utilisée si elle existe.</p>
        <div id="coverDrop" class="dropzone">
          <div class="big">Déposez une image de pochette</div>
          <div>ou cliquez pour choisir (jpg / png)</div>
          <input type="file" id="coverInput" accept="image/*" hidden>
        </div>
        <div id="coverPreview" style="margin-top:16px;display:none;">
          <img id="coverImg" style="max-width:200px;border-radius:8px;box-shadow:var(--shadow);">
        </div>
      </section>

      <section class="section">
        <h3>Morceaux <span id="totalDur" class="eyebrow" style="float:right"></span></h3>
        <div id="songsDrop" class="dropzone">
          <div class="big">Déposez les MP3 ici, dans n'importe quel ordre</div>
          <div>ou cliquez pour choisir. Glissez les lignes pour réordonner.</div>
          <input type="file" id="songsInput" accept="audio/mpeg,audio/mp4,audio/flac,audio/aiff,audio/wav,audio/ogg,.mp3,.m4a,.flac,.aiff,.aif,.wav,.ogg" multiple hidden>
        </div>
        <ul id="queue" class="queue" style="margin-top:24px;"></ul>
      </section>

      <div style="display:flex;gap:12px;justify-content:flex-end;margin-top:32px;">
        <button id="saveDraft" class="btn-ghost">Enregistrer le brouillon</button>
        <button id="publish" class="btn-accent">Publier la compilation</button>
      </div>
    </div>
  `;

  // ---- Cover picker ----
  const coverDrop = el.querySelector('#coverDrop');
  const coverInput = el.querySelector('#coverInput');
  let coverFile = null;
  // Show the draft's current cover, if any.
  if (coverPath) {
    coverUrl(coverPath).then((url) => {
      if (!url) return;
      el.querySelector('#coverImg').src = url;
      el.querySelector('#coverPreview').style.display = 'block';
    });
  }
  coverDrop.addEventListener('click', () => coverInput.click());
  coverDrop.addEventListener('dragover', (e) => { e.preventDefault(); coverDrop.classList.add('over'); });
  coverDrop.addEventListener('dragleave', () => coverDrop.classList.remove('over'));
  coverDrop.addEventListener('drop', (e) => {
    e.preventDefault();
    coverDrop.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith('image/')) handleCover(f);
  });
  coverInput.addEventListener('change', () => handleCover(coverInput.files[0]));
  function handleCover(f) {
    coverFile = f;
    const url = URL.createObjectURL(f);
    el.querySelector('#coverImg').src = url;
    el.querySelector('#coverPreview').style.display = 'block';
  }

  // ---- Songs picker ----
  const songsDrop = el.querySelector('#songsDrop');
  const songsInput = el.querySelector('#songsInput');
  const queueEl = el.querySelector('#queue');
  const totalDurEl = el.querySelector('#totalDur');

  songsDrop.addEventListener('click', () => songsInput.click());
  songsDrop.addEventListener('dragover', (e) => { e.preventDefault(); songsDrop.classList.add('over'); });
  songsDrop.addEventListener('dragleave', () => songsDrop.classList.remove('over'));
  songsDrop.addEventListener('drop', (e) => { e.preventDefault(); songsDrop.classList.remove('over'); addFiles([...e.dataTransfer.files]); });
  songsInput.addEventListener('change', () => addFiles([...songsInput.files]));

  async function addFiles(files) {
    const audioExts = /\.(mp3|m4a|flac|aiff?|wav|ogg)$/i;
    const mp3s = files.filter((f) => f.type.startsWith('audio/') || audioExts.test(f.name));
    for (const file of mp3s) {
      const item = { kind: 'new', file, status: 'pending', progress: 0, title: file.name, artist: '', duration: 0 };
      items.push(item);
      renderQueue();
      try {
        const meta = await parseBlob(file, { duration: true });
        item.title = meta.common.title || file.name;
        item.artist = meta.common.artist || '';
        item.duration = meta.format.duration || 0;
      } catch (_) { /* ignore */ }
      renderQueue();
    }
  }

  function liveItems() { return items.filter((it) => !it.removed); }

  function renderQueue() {
    queueEl.innerHTML = '';
    items.forEach((it, i) => {
      const li = document.createElement('li');
      li.draggable = !it.removed;
      li.dataset.idx = i;
      if (it.removed) li.classList.add('deleted');
      const statusCls = it.status === 'done' || it.status === 'uploaded' ? 'ok'
        : it.status === 'error' ? 'err' : it.status === 'dup' ? 'dup' : '';
      li.innerHTML = `
        <span class="grip">⋮⋮</span>
        <div>
          <div>${escape(it.title)}</div>
          <div style="color:var(--ink-dim);font-size:12px;font-style:italic">${escape(it.artist)} · ${fmtDur(it.duration)}</div>
        </div>
        <div class="progress"><span style="width:${(it.progress ? it.progress * 100 : 0).toFixed(0)}%"></span></div>
        <div class="status ${statusCls}">${STATUS_LABEL[it.status] || it.status}</div>
        ${it.removed ? '<a href="#" class="row-undo">annuler</a>' : '<button class="row-del" title="Retirer" aria-label="Retirer">✕</button>'}
      `;
      // Drag reorder (skip while uploading).
      li.addEventListener('dragstart', (e) => { li.classList.add('dragging'); e.dataTransfer.setData('text/plain', i); });
      li.addEventListener('dragend', () => li.classList.remove('dragging'));
      li.addEventListener('dragover', (e) => e.preventDefault());
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        const from = +e.dataTransfer.getData('text/plain');
        const to = +li.dataset.idx;
        if (from === to) return;
        const moved = items.splice(from, 1)[0];
        items.splice(to, 0, moved);
        renderQueue();
      });
      li.querySelector('.row-del')?.addEventListener('click', () => {
        if (it.kind === 'existing') { it.removed = true; renderQueue(); } // soft-delete uploaded songs
        else { items.splice(items.indexOf(it), 1); renderQueue(); }       // drop not-yet-uploaded files
      });
      li.querySelector('.row-undo')?.addEventListener('click', (e) => { e.preventDefault(); it.removed = false; renderQueue(); });
      queueEl.appendChild(li);
    });
    const total = liveItems().reduce((acc, it) => acc + (it.duration || 0), 0);
    const tot = fmtDur(total);
    totalDurEl.textContent = total ? `${tot} au total${total > 80 * 60 ? ' — plus de 80 min !' : ''}` : '';
    totalDurEl.style.color = total > 80 * 60 ? 'var(--accent)' : 'var(--ink-faint)';
  }
  renderQueue();

  // ---- Save / Publish ----
  const errEl = el.querySelector('#error');
  const okEl = el.querySelector('#ok');
  const saveBtn = el.querySelector('#saveDraft');
  const publishBtn = el.querySelector('#publish');

  async function persist({ publish }) {
    errEl.hidden = true; okEl.hidden = true;
    const title = el.querySelector('#title').value.trim();
    if (!title) { errEl.textContent = 'Donne un titre à ta compilation.'; errEl.hidden = false; return; }
    if (publish && liveItems().length === 0) {
      errEl.textContent = 'Ajoute au moins un morceau avant de publier.'; errEl.hidden = false; return;
    }

    saveBtn.disabled = true; publishBtn.disabled = true;
    const activeBtn = publish ? publishBtn : saveBtn;
    const activeLabel = activeBtn.textContent;
    activeBtn.textContent = publish ? 'Publication…' : 'Enregistrement…';

    try {
      // 1. Create the draft on first save.
      if (!compId) {
        const ref = await addDoc(collection(db, 'compilations'), {
          title, season: slot.season, year: slot.year, author: emailKey,
          coverPath: null, coverSource: null, status: 'draft',
          trackCount: 0, totalDuration: 0,
          createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
        });
        compId = ref.id;
        upsertCompilationLocal(compId, {
          title, season: slot.season, year: slot.year, author: emailKey,
          coverPath: null, status: 'draft', trackCount: 0, totalDuration: 0,
        });
      }

      // 2. Cover (if a new one was picked).
      if (coverFile) {
        const res = await uploadCover({ file: coverFile, compilationId: compId });
        coverPath = res.coverPath;
        invalidateCover(coverPath);
        coverFile = null;
      }

      // 3. Upload new songs (in their current live order).
      const ordered = liveItems();
      const newOnes = ordered.filter((it) => it.kind === 'new' && it.status !== 'done');
      const tasks = newOnes.map((it) => async () => {
        it.status = 'uploading'; renderQueue();
        try {
          const result = await uploadSong({
            file: it.file, compilationId: compId, order: ordered.indexOf(it),
            onProgress: (p) => { it.progress = p; renderQueue(); },
          });
          it.progress = 1; it.status = result.dedupHit ? 'dup' : 'done';
          it.songId = result.songId; it.kind = 'existing';
          if (result.duration) it.duration = result.duration;
          renderQueue();
          return result;
        } catch (err) {
          it.status = 'error'; renderQueue(); throw err;
        }
      });
      const results = await runWithConcurrency(tasks, 3);
      const failures = results.filter((r) => !r.ok);
      if (failures.length) throw new Error(`${failures.length} morceau(x) n'ont pas pu être envoyés. Réessaie.`);

      // 4. Reorder surviving songs + delete removed ones + finalize comp, in one batch.
      const batch = writeBatch(db);
      const compRef = doc(db, 'compilations', compId);
      const survivors = liveItems(); // all now have songId
      let total = 0;
      survivors.forEach((it, i) => {
        total += it.duration || 0;
        batch.update(doc(db, 'compilations', compId, 'songs', it.songId), { order: i, updatedAt: serverTimestamp() });
      });
      items.filter((it) => it.removed && it.songId).forEach((it) => {
        batch.delete(doc(db, 'compilations', compId, 'songs', it.songId));
      });
      const finalStatus = publish ? 'published' : 'draft';
      batch.update(compRef, {
        title, status: finalStatus,
        trackCount: survivors.length, totalDuration: total,
        updatedAt: serverTimestamp(),
      });
      await batch.commit();

      // 5. Sync local catalog + UI.
      upsertCompilationLocal(compId, {
        title, status: finalStatus, coverPath,
        trackCount: survivors.length, totalDuration: total,
      });
      // Drop the deleted rows from the working list now they're gone server-side.
      for (let i = items.length - 1; i >= 0; i--) if (items[i].removed) items.splice(i, 1);
      renderQueue();

      if (publish) {
        navigate(`/c/${compId}`);
      } else {
        okEl.textContent = 'Brouillon enregistré. Tu peux fermer et revenir plus tard.';
        okEl.hidden = false;
      }
    } catch (err) {
      errEl.textContent = err.message || String(err);
      errEl.hidden = false;
    } finally {
      saveBtn.disabled = false; publishBtn.disabled = false;
      activeBtn.textContent = activeLabel;
    }
  }

  saveBtn.addEventListener('click', () => persist({ publish: false }));
  publishBtn.addEventListener('click', () => persist({ publish: true }));
}
