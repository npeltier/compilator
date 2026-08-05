// Admin-only data-validation screen at /validate.
//
// Lists every song that's under-determined — missing a title, artist, year, or
// country, OR carrying a country we're not sure about — and lets an admin amend
// it inline. Saves write straight to the song doc (rules already allow admin
// writes) and stamp `geoManual` so the geo backfill/enrichment never overwrites a
// human correction.
//
// "Not sure about" = geoSource 'musicbrainz-ambiguous': MusicBrainz had two
// same-named artists from different places with near-identical search scores, so
// the stored country is a coin-flip. The rival candidates ride along in
// `geoAlternatives` and are shown on the row so the choice can be made here.

import { requireAdmin } from '../auth-guard.js';
import { db } from '../firebase-init.js';
import {
  doc,
  updateDoc,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js';
import { ensureSongsLoaded, visibleSongs, getCompilation, updateSongLocal } from '../catalog.js';
import { loadCountryOptions, countryOptionsHTML, countryName } from '../countries.js';
import { recomputeDoublons } from '../upload-pipeline.js';

const PAGE = 40;

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const plausibleYear = (y) => { const n = parseInt(y, 10); return Number.isFinite(n) && n >= 1900 && n <= 2035; };

// Keep in sync with AMBIGUOUS_SOURCE in functions/geo.js (no shared module
// between the browser bundle and the functions runtime).
const AMBIGUOUS_SOURCE = 'musicbrainz-ambiguous';
// A human decision wins: once geoManual is set the row is settled, whatever the
// automated source said.
const isAmbiguous = (s) => s.geoSource === AMBIGUOUS_SOURCE && !s.geoManual;
const needsReview = (s) => !s.title || !s.artist || !plausibleYear(s.year) || !s.artistCountry || isAmbiguous(s);

export async function mount(el, { query }) {
  await requireAdmin(); // redirects non-admins
  el.innerHTML = `<div class="shell"><div class="notice">Chargement…</div></div>`;
  const [countries] = await Promise.all([loadCountryOptions(), ensureSongsLoaded()]);

  const optionsHTML = (selected) => countryOptionsHTML(countries, selected);

  // Uncertain-country rows first: they're the ones a human can settle quickly
  // from the alternatives shown, and they're invisible everywhere else.
  const all = visibleSongs().filter(needsReview)
    .sort((a, b) => Number(isAmbiguous(b)) - Number(isAmbiguous(a)));
  const ambiguousCount = all.filter(isAmbiguous).length;
  let page = Math.max(0, Number(query?.page) || 0);
  const pages = Math.max(1, Math.ceil(all.length / PAGE));

  function render() {
    page = Math.min(page, pages - 1);
    const slice = all.slice(page * PAGE, page * PAGE + PAGE);
    el.innerHTML = `
      <div class="shell">
        <h1>À valider</h1>
        <p class="map-sub">${all.length} morceau(x) à revoir — titre, artiste, année ou pays manquant${ambiguousCount ? `, dont ${ambiguousCount} au pays incertain` : ''}.</p>
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
    // An uncertain country looks filled-in, so mark the field and spell out what
    // MusicBrainz was torn between — otherwise there's nothing to act on.
    const doubt = isAmbiguous(s) ? ' vld-doubt' : '';
    const alts = isAmbiguous(s) && s.geoAlternatives?.length
      ? `<div class="vld-alts">Pays incertain — autres candidats : ${s.geoAlternatives.map(escape).join(' · ')}</div>`
      : (isAmbiguous(s) ? '<div class="vld-alts">Pays incertain (homonymes sur MusicBrainz).</div>' : '');
    return `
      <div class="vld-row${doubt}" data-comp="${escape(s.compilationId)}" data-song="${escape(s.id)}" data-idx="${idx}">
        ${alts}
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
    const song = all[Number(row.dataset.idx)];
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
        // The paired code the lookup stored alongside the region — left behind,
        // it contradicts a region the admin just cleared or rewrote.
        artistRegionCode: null,
        geoManual: true, // never auto-overwrite this correction
        // Retire the provisional marker: this is now a human answer, so the row
        // stops showing up here and stops being re-resolved by the backfill.
        geoSource: 'manual',
        geoAlternatives: null,
        metaManual: true,
      };
      const artistChanged = (patch.artist || '') !== (song?.artist || '');
      btn.disabled = true;
      status.textContent = '…';
      try {
        await updateDoc(
          doc(db, 'compilations', row.dataset.comp, 'songs', row.dataset.song),
          { ...patch, updatedAt: serverTimestamp() },
        );
        // Keep the in-memory catalog in step with what we just wrote, or a
        // re-render (paging back to this row) resurrects the old values from the
        // stale object — and a second save would write them back.
        updateSongLocal(row.dataset.song, patch);
        status.textContent = '✓';
        row.classList.add('vld-done');
        // A corrected artist invalidates the duplicate chips on both sides: the
        // song's own sameArtist list and those of the songs that used to match
        // the wrong name. The server pass converges the lot.
        if (artistChanged) {
          try {
            await recomputeDoublons(row.dataset.comp);
          } catch (e) {
            console.warn('recomputeDoublons failed (non-fatal):', e);
          }
        }
      } catch (err) {
        status.textContent = `✗ ${err.code || err.message}`;
        btn.disabled = false;
      }
    });
  }

  render();
}
