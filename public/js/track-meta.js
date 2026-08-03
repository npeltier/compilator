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

const DISCOGS_ARTIST = (id) => `https://www.discogs.com/artist/${encodeURIComponent(id)}`;

function mmss(secs) {
  const n = Math.round(Number(secs) || 0);
  if (!n) return '';
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}

// One <dt>/<dd> pair, skipped entirely when there's no value — so the panel never
// shows an empty label for data we don't have.
function row(label, valueHTML) {
  return valueHTML ? `<dt>${escape(label)}</dt><dd>${valueHTML}</dd>` : '';
}

/**
 * The full detail panel for a track: everything we know about the artist (origin,
 * Discogs page, bio) and the recording (compilation, year, label, track, length,
 * Discogs release), plus the duplicate chips. Drives the player's second screen.
 *
 * Takes a catalog song doc. Sections with no data are omitted rather than shown
 * empty, so a barely-enriched track degrades to just its title.
 */
export function artistDetailHTML(song, { compilationId = null } = {}) {
  if (!song) return '';

  const place = [song.artistTown, song.artistRegion, song.artistCountry].filter(Boolean).join(', ');
  const artistRows = [
    row('Origine', place ? escape(place) : ''),
    row('Discogs', song.discogs?.artistId
      ? `<a href="${escape(DISCOGS_ARTIST(song.discogs.artistId))}" target="_blank" rel="noopener">Page artiste ↗</a>`
      : ''),
  ].join('');
  const bio = song.artistBio ? `<p class="pfd-bio">${escape(song.artistBio)}</p>` : '';
  const artistBlock = (song.artist || artistRows || bio)
    ? `<section class="pfd-block">
         <h3 class="pfd-h">Artiste</h3>
         ${song.artist ? `<div class="pfd-name">${escape(song.artist)}</div>` : ''}
         ${artistRows ? `<dl class="pfd-rows">${artistRows}</dl>` : ''}
         ${bio}
       </section>`
    : '';

  const comp = compilationId ? getCompilation(compilationId) : null;
  const trackRows = [
    row('Compilation', comp
      ? `<a href="/c/${escape(compilationId)}">${escape(comp.title || compilationId)}</a>`
      : ''),
    row('Année', song.year ? escape(String(song.year)) : ''),
    row('Label', song.label ? escape(song.label) : ''),
    row('Piste', song.track ? escape(String(song.track)) : ''),
    row('Durée', escape(mmss(song.duration))),
    row('Disque', song.discogs?.releaseUrl
      ? `<a href="${escape(song.discogs.releaseUrl)}" target="_blank" rel="noopener">Discogs ↗</a>`
      : ''),
  ].join('');
  const trackBlock = trackRows
    ? `<section class="pfd-block"><h3 class="pfd-h">Morceau</h3><dl class="pfd-rows">${trackRows}</dl></section>`
    : '';

  const chips = doublonChipsHTML(song.doublons, compilationId);
  const chipsBlock = chips
    ? `<section class="pfd-block"><h3 class="pfd-h">Aussi dans</h3>${chips}</section>`
    : '';

  if (!artistBlock && !trackBlock && !chipsBlock) return '';
  return `<div class="pfd">${artistBlock}${trackBlock}${chipsBlock}</div>`;
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
  const place = [t.artistTown, t.artistRegion, t.artistCountry].filter(Boolean).join(', ');
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
