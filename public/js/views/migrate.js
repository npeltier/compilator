// Admin-only bulk import view: drop legacy ZIPs, extract MP3s in the browser
// and upload them via the same pipeline as the fancy upload page.

import { db } from '../firebase-init.js';
import { requireAdmin } from '../auth-guard.js';
import { uploadSong, runWithConcurrency } from '../upload-pipeline.js';
import { allAuthorOptions } from '../catalog.js';
import {
  addDoc,
  collection,
  serverTimestamp,
  updateDoc,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js';
import JSZip from 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';
import { parseBlob } from 'https://cdn.jsdelivr.net/npm/music-metadata-browser@2.5.10/+esm';

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function fmtDur(s) {
  return isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '';
}

const STATUS_LABEL = { pending: 'en attente', uploading: 'envoi…', done: 'ok', error: 'erreur', dup: 'doublon', imported: 'importée' };

export async function mount(el) {
  // Admin-only — bounces non-admins to /.
  const user = await requireAdmin();
  const myEmail = user.email.toLowerCase();
  const authorOptions = allAuthorOptions();
  const optionsHTML = (selectedEmail) => authorOptions
    .map((u) => `<option value="${escape(u.email)}" ${u.email === selectedEmail ? 'selected' : ''}>${escape(u.displayName)}${u.linked ? '' : ' (en attente)'}</option>`)
    .join('');

  el.innerHTML = `
    <div class="shell-narrow">
      <p class="eyebrow">Migration</p>
      <h1>Importer les ZIP historiques.</h1>
      <p class="notice">
        Glissez un ou plusieurs fichiers ZIP (du type de ceux qui vivaient sur
        <code>nicolas.peltier1.free.fr/liste.html</code>). Chaque ZIP devient une compilation.
        Les MP3 sont extraits dans le navigateur et envoyés un par un.
      </p>

      <div id="error" class="error" hidden></div>

      <section class="section" style="background:var(--bg-elev);border:1px solid var(--line);border-radius:var(--radius-lg);padding:20px;margin-bottom:24px;">
        <h3 style="border:none;margin-bottom:12px;">Valeurs par défaut</h3>
        <p style="color:var(--ink-faint);font-size:12px;margin:-4px 0 16px;">Appliquées à chaque ZIP au moment où tu le déposes. Modifiables ensuite par carte.</p>
        <div class="field-row">
          <div>
            <label for="defSeason">Saison</label>
            <select id="defSeason">
              <option value="ete">Été</option>
              <option value="noel">Noël</option>
            </select>
          </div>
          <div>
            <label for="defYear">Année</label>
            <input id="defYear" type="number" min="2010" max="2099" value="">
          </div>
          <div>
            <label for="defAuthor">Auteur</label>
            <select id="defAuthor">${optionsHTML(myEmail)}</select>
          </div>
        </div>
      </section>

      <div id="drop" class="dropzone">
        <div class="big">Déposez des ZIP ici</div>
        <div>ou cliquez pour choisir</div>
        <input type="file" id="zipInput" accept=".zip,application/zip" multiple hidden>
      </div>

      <div id="zips" style="margin-top:32px;"></div>

      <button id="importAll" class="btn-accent" disabled style="margin-top:24px;width:100%;padding:14px;">Tout importer</button>
    </div>
  `;

  const defSeason = el.querySelector('#defSeason');
  const defYear = el.querySelector('#defYear');
  const defAuthor = el.querySelector('#defAuthor');
  defAuthor.value = myEmail;
  defYear.value = new Date().getFullYear();
  function defaults() {
    return {
      season: defSeason.value,
      year: defYear.value,
      author: defAuthor.value,
    };
  }

  const drop = el.querySelector('#drop');
  const input = el.querySelector('#zipInput');
  const zipsEl = el.querySelector('#zips');
  const importAllBtn = el.querySelector('#importAll');
  const zips = [];

  drop.addEventListener('click', () => input.click());
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); addZips([...e.dataTransfer.files]); });
  input.addEventListener('change', () => addZips([...input.files]));

  async function addZips(files) {
    for (const f of files) {
      if (!f.name.toLowerCase().endsWith('.zip')) continue;
      const d = defaults();
      const card = {
        file: f, songs: [], status: 'pending',
        season: d.season, year: d.year, author: d.author,
      };
      zips.push(card);
      renderZips();
      try {
        const z = await JSZip.loadAsync(f);
        const entries = Object.values(z.files).filter((e) => !e.dir && /\.mp3$/i.test(e.name));
        card.songs = await Promise.all(entries.map(async (entry) => {
          const blob = await entry.async('blob');
          let trackNo = 0; let title = entry.name; let artist = ''; let duration = 0;
          try {
            const meta = await parseBlob(blob, { duration: true });
            trackNo = meta.common.track?.no || 0;
            title = meta.common.title || entry.name.replace(/\.mp3$/i, '');
            artist = meta.common.artist || '';
            duration = meta.format.duration || 0;
          } catch (_) { /* ignore */ }
          return { blob, name: entry.name, trackNo, title, artist, duration, status: 'pending', progress: 0 };
        }));
        card.songs.sort((a, b) => (a.trackNo || 9999) - (b.trackNo || 9999) || a.name.localeCompare(b.name));
      } catch (err) {
        card.status = 'error';
        card.error = err.message;
      }
      renderZips();
    }
    importAllBtn.disabled = zips.length === 0;
  }

  function inferFromFilename(name) {
    const stem = name.replace(/\.zip$/i, '');
    return { title: stem.replace(/[_-]/g, ' ') };
  }

  function renderZips() {
    zipsEl.innerHTML = '';
    zips.forEach((c) => {
      const guess = inferFromFilename(c.file.name);
      const card = document.createElement('div');
      card.className = 'zip-card';
      card.innerHTML = `
        <div class="head">
          <h4>${escape(guess.title)}</h4>
          <span class="filename">${escape(c.file.name)} · ${c.songs.length} MP3</span>
        </div>
        <div class="zip-meta">
          <div>
            <label>Titre</label>
            <input data-k="title" value="${escape(c.title || guess.title)}">
          </div>
          <div>
            <label>Saison</label>
            <select data-k="season">
              <option value="ete" ${c.season === 'ete' ? 'selected' : ''}>Été</option>
              <option value="noel" ${c.season === 'noel' ? 'selected' : ''}>Noël</option>
            </select>
          </div>
          <div>
            <label>Année</label>
            <input data-k="year" type="number" value="${c.year || ''}" placeholder="2024">
          </div>
          <div>
            <label>Auteur</label>
            <select data-k="author">${optionsHTML(c.author)}</select>
          </div>
        </div>
        <ul class="queue">
          ${c.songs.map((s) => `
            <li>
              <span class="grip">⋮</span>
              <div>
                <div>${escape(s.title)}</div>
                <div style="color:var(--ink-dim);font-size:12px;font-style:italic">${escape(s.artist)} · ${fmtDur(s.duration)}</div>
              </div>
              <div class="progress"><span style="width:${(s.progress * 100).toFixed(0)}%"></span></div>
              <div class="status ${s.status === 'done' ? 'ok' : s.status === 'error' ? 'err' : s.status === 'dup' ? 'dup' : ''}">${STATUS_LABEL[s.status] || s.status}</div>
            </li>
          `).join('')}
        </ul>
      `;
      card.querySelectorAll('[data-k]').forEach((cell) => {
        const evt = cell.tagName === 'SELECT' ? 'change' : 'input';
        cell.addEventListener(evt, () => {
          c[cell.dataset.k] = cell.value;
        });
      });
      zipsEl.appendChild(card);
    });
  }

  importAllBtn.addEventListener('click', async () => {
    importAllBtn.disabled = true; importAllBtn.textContent = 'Import en cours…';
    const errEl = el.querySelector('#error');
    errEl.hidden = true;
    try {
      for (const c of zips) {
        if (c.status === 'imported' || c.songs.length === 0) continue;
        const compRef = await addDoc(collection(db, 'compilations'), {
          title: c.title || inferFromFilename(c.file.name).title,
          season: c.season || 'ete',
          year: parseInt(c.year, 10) || new Date().getFullYear(),
          // Author is the lowercased email — may be a user who hasn't signed in
          // yet (allowlist-only). Rules permit non-self author for admins.
          author: (c.author || myEmail).toLowerCase(),
          coverPath: null,
          coverSource: null,
          status: 'draft',
          trackCount: 0,
          totalDuration: 0,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        const tasks = c.songs.map((s, idx) => async () => {
          s.status = 'uploading'; renderZips();
          try {
            const result = await uploadSong({
              file: s.blob,
              filename: s.name,
              compilationId: compRef.id,
              order: idx,
              onProgress: (p) => { s.progress = p; renderZips(); },
            });
            s.progress = 1;
            s.status = result.dedupHit ? 'dup' : 'done';
            renderZips();
            return result;
          } catch (err) {
            s.status = 'error'; s.error = err.message; renderZips();
            throw err;
          }
        });
        const results = await runWithConcurrency(tasks, 3);
        const failed = results.filter((r) => !r.ok).length;
        if (failed === 0) {
          await updateDoc(compRef, { status: 'published' });
          c.status = 'imported';
        } else {
          c.status = `importée avec ${failed} échec(s)`;
        }
      }
    } catch (err) {
      errEl.textContent = err.message || String(err);
      errEl.hidden = false;
    } finally {
      importAllBtn.textContent = 'Tout importer';
      importAllBtn.disabled = false;
    }
  });
}
