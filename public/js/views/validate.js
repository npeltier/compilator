// Admin-only data-validation screen at /validate.
//
// Lists every song that's under-determined — missing a title, artist, year, or
// country — and lets an admin amend it inline. Saves write straight to the song
// doc (rules already allow admin writes) and stamp `geoManual` so the geo
// backfill/enrichment never overwrites a human correction.

import { requireAdmin } from '../auth-guard.js';
import { db } from '../firebase-init.js';
import {
  doc,
  updateDoc,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js';
import { ensureSongsLoaded, visibleSongs, getCompilation } from '../catalog.js';
import { loadCountryOptions, countryOptionsHTML, countryName } from '../countries.js';

const PAGE = 40;

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const plausibleYear = (y) => { const n = parseInt(y, 10); return Number.isFinite(n) && n >= 1900 && n <= 2035; };
const isIncomplete = (s) => !s.title || !s.artist || !plausibleYear(s.year) || !s.artistCountry;

export async function mount(el, { query }) {
  await requireAdmin(); // redirects non-admins
  el.innerHTML = `<div class="shell"><div class="notice">Chargement…</div></div>`;
  const [countries] = await Promise.all([loadCountryOptions(), ensureSongsLoaded()]);

  const optionsHTML = (selected) => countryOptionsHTML(countries, selected);

  const all = visibleSongs().filter(isIncomplete);
  let page = Math.max(0, Number(query?.page) || 0);
  const pages = Math.max(1, Math.ceil(all.length / PAGE));

  function render() {
    page = Math.min(page, pages - 1);
    const slice = all.slice(page * PAGE, page * PAGE + PAGE);
    el.innerHTML = `
      <div class="shell">
        <h1>À valider</h1>
        <p class="map-sub">${all.length} morceau(x) incomplet(s) — titre, artiste, année ou pays manquant.</p>
        <div class="vld-list">
          ${slice.map((s, i) => rowHTML(s, page * PAGE + i)).join('') || '<div class="notice">Rien à valider 🎉</div>'}
        </div>
        <div class="vld-pager">
          <button class="btn-ghost" id="vldPrev" ${page === 0 ? 'disabled' : ''}>‹ Précédent</button>
          <span>Page ${page + 1} / ${pages}</span>
          <button class="btn-ghost" id="vldNext" ${page >= pages - 1 ? 'disabled' : ''}>Suivant ›</button>
        </div>
      </div>`;
    el.querySelectorAll('.vld-country').forEach((sel) => { sel.innerHTML = optionsHTML(sel.dataset.code || ''); });
    el.querySelector('#vldPrev')?.addEventListener('click', () => { page -= 1; render(); });
    el.querySelector('#vldNext')?.addEventListener('click', () => { page += 1; render(); });
    el.querySelectorAll('.vld-row').forEach(wireRow);
  }

  function rowHTML(s, idx) {
    const comp = getCompilation(s.compilationId);
    const miss = (v) => (v ? '' : ' vld-miss');
    return `
      <div class="vld-row" data-comp="${escape(s.compilationId)}" data-song="${escape(s.id)}" data-idx="${idx}">
        <div class="vld-src">${escape(comp?.title || s.compilationId)}</div>
        <input class="vld-title${miss(s.title)}" data-f="title" value="${escape(s.title || '')}" placeholder="titre" aria-label="Titre">
        <input class="vld-artist${miss(s.artist)}" data-f="artist" value="${escape(s.artist || '')}" placeholder="artiste" aria-label="Artiste">
        <input class="vld-year${miss(plausibleYear(s.year))}" data-f="year" value="${escape(plausibleYear(s.year) ? s.year : '')}" placeholder="année" inputmode="numeric" aria-label="Année">
        <select class="vld-country${miss(s.artistCountry)}" data-f="country" data-code="${escape(s.artistCountryCode || '')}" aria-label="Pays"></select>
        <input class="vld-region" data-f="region" value="${escape(s.artistRegion || '')}" placeholder="région" aria-label="Région">
        <button class="btn-accent vld-save">Enregistrer</button>
        <span class="vld-status" aria-live="polite"></span>
      </div>`;
  }

  function wireRow(row) {
    const btn = row.querySelector('.vld-save');
    const status = row.querySelector('.vld-status');
    btn.addEventListener('click', async () => {
      const val = (f) => row.querySelector(`[data-f="${f}"]`).value.trim();
      const countrySel = row.querySelector('.vld-country');
      const code = countrySel.value || null;
      const country = code ? countryName(countries, code) : null;
      const yearRaw = val('year');
      const patch = {
        title: val('title') || null,
        artist: val('artist') || null,
        year: plausibleYear(yearRaw) ? Number(yearRaw) : null,
        artistCountry: country,
        artistCountryCode: code,
        artistRegion: val('region') || null,
        geoManual: true, // never auto-overwrite this correction
        metaManual: true,
        updatedAt: serverTimestamp(),
      };
      btn.disabled = true;
      status.textContent = '…';
      try {
        await updateDoc(doc(db, 'compilations', row.dataset.comp, 'songs', row.dataset.song), patch);
        status.textContent = '✓';
        row.classList.add('vld-done');
      } catch (err) {
        status.textContent = `✗ ${err.code || err.message}`;
        btn.disabled = false;
      }
    });
  }

  render();
}
