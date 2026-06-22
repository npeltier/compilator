// Shared renderers for per-track metadata: duplicate ("doublons") chips and the
// Discogs enrichment line (year · label · place, release link, artist bio).
// Used by the compilation view (inline track rows) and the full-screen player
// overlay so both stay in sync.

import { coverUrl } from './image-url.js';
import { getCompilation } from './catalog.js';

export function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Clickable cover chips linking to other compilations that contain the same
// track (exact audio hash) or the same artist. Emits `.doublon-cover[data-cover-path]`
// placeholders painted lazily by paintDoublonCovers().
export function doublonChipsHTML(doublons, currentCompId) {
  if (!doublons) return '';
  const chips = [];

  const seenTrack = new Set();
  for (const { compilationId } of doublons.sameTrack || []) {
    if (compilationId === currentCompId || seenTrack.has(compilationId)) continue;
    seenTrack.add(compilationId);
    const comp = getCompilation(compilationId);
    if (!comp) continue;
    const fallback = escape((comp.title || '?')[0].toUpperCase());
    const coverAttr = comp.coverPath ? ` data-cover-path="${escape(comp.coverPath)}"` : '';
    chips.push(`<a class="doublon-chip same-track" href="/c/${compilationId}" title="doublon · ${escape(comp.title)}"><div class="doublon-cover${comp.coverPath ? '' : ' placeholder'}"${coverAttr}>${comp.coverPath ? '' : fallback}</div></a>`);
  }

  const seenArtist = new Set();
  for (const { compilationId } of doublons.sameArtist || []) {
    if (compilationId === currentCompId || seenArtist.has(compilationId)) continue;
    seenArtist.add(compilationId);
    const comp = getCompilation(compilationId);
    if (!comp) continue;
    const fallback = escape((comp.title || '?')[0].toUpperCase());
    const coverAttr = comp.coverPath ? ` data-cover-path="${escape(comp.coverPath)}"` : '';
    chips.push(`<a class="doublon-chip same-artist" href="/c/${compilationId}" title="doublon d'artiste · ${escape(comp.title)}"><div class="doublon-cover${comp.coverPath ? '' : ' placeholder'}"${coverAttr}>${comp.coverPath ? '' : fallback}</div></a>`);
  }

  if (!chips.length) return '';
  return `<div class="tk-doublons">${chips.join('')}</div>`;
}

// Resolve and paint cover background images for any `.doublon-cover[data-cover-path]`
// elements inside `rootEl`.
export async function paintDoublonCovers(rootEl) {
  const covers = rootEl.querySelectorAll('.doublon-cover[data-cover-path]');
  await Promise.all([...covers].map(async (el) => {
    const url = await coverUrl(el.dataset.coverPath);
    if (url) el.style.backgroundImage = `url(${url})`;
  }));
}

// Discogs enrichment line: facts (year · label · town, country), a link to the
// release page, and the artist bio. Returns '' when the track carries none.
//
// `bio` controls how the bio renders:
//   'toggle' — hidden, with a "bio" button (caller wires the toggle). [default]
//   'block'  — always visible (no button).
//   'none'   — omitted.
export function enrichFactsHTML(t, { bio = 'toggle' } = {}) {
  const facts = [];
  if (t.year) facts.push(escape(String(t.year)));
  if (t.label) facts.push(escape(t.label));
  const place = [t.artistTown, t.artistCountry].filter(Boolean).join(', ');
  if (place) facts.push(escape(place));

  const link = t.discogsUrl
    ? `<a class="tk-discogs" href="${escape(t.discogsUrl)}" target="_blank" rel="noopener" title="Voir le disque sur Discogs">Discogs ↗</a>`
    : '';
  const hasBio = !!t.artistBio && bio !== 'none';
  const bioBtn = (hasBio && bio === 'toggle')
    ? `<button type="button" class="tk-bio-toggle" aria-expanded="false">bio</button>`
    : '';
  if (!facts.length && !link && !hasBio) return '';

  const factsHTML = facts.length ? `<span class="tk-facts">${facts.join(' · ')}</span>` : '';
  let bioHTML = '';
  if (hasBio && bio === 'toggle') bioHTML = `<div class="tk-bio" hidden>${escape(t.artistBio)}</div>`;
  else if (hasBio && bio === 'block') bioHTML = `<div class="tk-bio">${escape(t.artistBio)}</div>`;
  return `<div class="tk-info">${factsHTML}${link}${bioBtn}</div>${bioHTML}`;
}
