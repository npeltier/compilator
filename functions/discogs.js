// Discogs enrichment: given a song's title + artist, look up the Discogs
// database to fill in the song's original-release year, the record label of the
// first release it appears on, a short artist bio, and (best-effort) a country.
//
// This module is dependency-light on purpose — no firebase-admin import — so it
// can be unit-tested in isolation and reused by both the onCreate trigger
// (functions/index.js) and the backfill script (scripts/enrich-discogs.js).
// The Firestore handle is always passed in (resolveToken), and HTTP goes through
// the global fetch (Node 18+).

import { normalizeArtist } from './doublons.js';

const DISCOGS_API = 'https://api.discogs.com';
// Discogs returns 403 without a descriptive User-Agent.
const USER_AGENT = 'Compilator/1.0 (+https://compilator-83816.web.app)';

// Artist strings that mean "no single artist" — never worth a Discogs lookup.
const VARIOUS_ARTISTS = new Set([
  'various', 'various artists', 'va', 'v/a', 'artistes divers', 'divers',
  'compilation', 'multi-interprètes', 'multi-interpretes',
]);
// Placeholder title (stored as null upstream, but guard the literal too).
const UNTITLED = new Set(['sans titre']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isVariousArtist(artist) {
  return VARIOUS_ARTISTS.has(normalizeArtist(artist));
}

/**
 * Whether a (title, artist) pair is worth enriching. Skip untitled tracks and
 * various-artist / empty artists.
 */
export function isEnrichable(title, artist) {
  const t = (title || '').trim().toLowerCase();
  const a = normalizeArtist(artist);
  if (!t || UNTITLED.has(t)) return false;
  if (!a || VARIOUS_ARTISTS.has(a)) return false;
  return true;
}

/**
 * Discogs profile text uses BBCode ([a=Name], [l=Label], [url=...]...[/url],
 * [b]…[/b]). Strip the markup while keeping the human-readable names/text.
 */
export function stripBBCode(s) {
  return String(s || '')
    .replace(/\[url=[^\]]+\]([^[]*)\[\/url\]/gi, '$1') // keep link text
    .replace(/\[(?:a|l|m)=([^\]]+)\]/gi, '$1')          // [a=Name] → Name
    .replace(/\[[^\]]*\]/g, '')                          // drop [b], [/b], [a123], …
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// Demonym → country, for bios that state nationality as an adjective
// ("Jamaican … singer") rather than a place phrase. Music-relevant subset;
// longest keys are matched first so "south african" wins over a bare match.
const DEMONYMS = {
  american: 'USA', british: 'UK', english: 'UK', scottish: 'UK', welsh: 'UK',
  irish: 'Ireland', french: 'France', german: 'Germany', italian: 'Italy',
  spanish: 'Spain', portuguese: 'Portugal', dutch: 'Netherlands', belgian: 'Belgium',
  swiss: 'Switzerland', austrian: 'Austria', swedish: 'Sweden', norwegian: 'Norway',
  danish: 'Denmark', finnish: 'Finland', icelandic: 'Iceland', greek: 'Greece',
  polish: 'Poland', czech: 'Czechia', hungarian: 'Hungary', romanian: 'Romania',
  russian: 'Russia', ukrainian: 'Ukraine', turkish: 'Turkey',
  jamaican: 'Jamaica', cuban: 'Cuba', 'puerto rican': 'Puerto Rico',
  canadian: 'Canada', mexican: 'Mexico', brazilian: 'Brazil', argentine: 'Argentina',
  argentinian: 'Argentina', chilean: 'Chile', colombian: 'Colombia',
  australian: 'Australia', 'new zealand': 'New Zealand',
  japanese: 'Japan', chinese: 'China', korean: 'South Korea', indian: 'India',
  thai: 'Thailand', vietnamese: 'Vietnam', indonesian: 'Indonesia', filipino: 'Philippines',
  nigerian: 'Nigeria', nigerien: 'Niger', ghanaian: 'Ghana', senegalese: 'Senegal',
  malian: 'Mali', kenyan: 'Kenya', ethiopian: 'Ethiopia', egyptian: 'Egypt',
  moroccan: 'Morocco', algerian: 'Algeria', tunisian: 'Tunisia',
  'south african': 'South Africa', congolese: 'Congo', cameroonian: 'Cameroon',
  'cape verdean': 'Cape Verde', israeli: 'Israel', lebanese: 'Lebanon', iranian: 'Iran',
};
const DEMONYM_RE = new RegExp(
  '\\b(' + Object.keys(DEMONYMS).sort((a, b) => b.length - a.length).join('|') + ')\\b',
  'i',
);

function demonymCountry(text) {
  const m = String(text).match(DEMONYM_RE);
  return m ? DEMONYMS[m[1].toLowerCase()] : null;
}

/**
 * Best-effort artist location from the (BBCode-stripped) bio. Discogs has no
 * structured nationality — but profiles routinely state it, e.g.
 *   "Born: 8 January 1947 in Brixton, London, England, UK."  → Brixton / UK
 *   "Tuareg musician from Tchintabaraden and Abalak, Niger." → Tchintabaraden / Niger
 *   "Jamaican … singer, born 26 June 1942, Kingston – died…" → Kingston / Jamaica
 * Strategy: (1) a "in/from/based in <place>" phrase → last comma-segment is the
 * country, first is the town; (2) fallback town from a "born …, <Town>" phrase
 * with no "in"; (3) fallback country from a leading nationality demonym. Returns
 * { town, country } with nulls when nothing recognizable is present.
 */
export function parseArtistLocation(bio) {
  const text = String(bio || '');
  let town = null;
  let country = null;

  const phrasePatterns = [
    /\bborn\b[^.\n]*?\bin\s+([^.\n]+)/i,
    /\bbased\s+in\s+([^.\n]+)/i,
    /\bfrom\s+([^.\n]+)/i,
  ];
  const placeLike = (s) => !!s && s.split(/\s+/).length <= 3;
  for (const re of phrasePatterns) {
    const m = text.match(re);
    if (!m) continue;
    const raw = m[1].trim();
    // Must look like a place: starts uppercase, no digits (filters "from the
    // 1970s", dates…), and no "to" — which signals a genre range ("from
    // Electronica to Bossa Nova") or messy over-capture, never a real country
    // (those use "and", e.g. "Trinidad and Tobago").
    if (!/^[A-ZÀ-Ÿ]/.test(raw) || /\d/.test(raw) || /\bto\b/i.test(raw)) continue;
    const segs = raw.split(',').map((s) => s.trim()).filter(Boolean);
    // The country is the last segment; bail if it doesn't look like a place name.
    if (!segs.length || !placeLike(segs[segs.length - 1])) continue;
    country = segs[segs.length - 1];
    // First segment is the town; collapse "Town A and Town B" to the first.
    town = segs.length > 1 && placeLike(segs[0]) ? (segs[0].split(/\s+and\s+/i)[0].trim() || null) : null;
    break;
  }

  // Fallback town: "born <date>, <Town>" with no "in" (stop at a dash/comma).
  if (!town) {
    const m = text.match(/\bborn\b[^.\n]*?,\s*([A-ZÀ-Ÿ][^.,\n–—-]+)/i);
    if (m) {
      const cand = m[1].trim();
      if (/^[A-ZÀ-Ÿ]/.test(cand) && !/\d/.test(cand) && !/\bto\b/i.test(cand) && placeLike(cand)) town = cand;
    }
  }

  // Fallback country: a nationality demonym anywhere in the bio.
  if (!country) country = demonymCountry(text);

  return { town: town || null, country: country || null };
}

/**
 * Pick the "first record where it shows": the earliest-year search result that
 * carries a label (fall back to the earliest of any result, then the first).
 */
export function pickRelease(results) {
  const list = (results || []).filter(Boolean);
  if (!list.length) return null;
  const yearOf = (r) => {
    const y = parseInt(String(r.year || '').slice(0, 4), 10);
    return Number.isFinite(y) && y > 0 ? y : Infinity;
  };
  const withLabel = list.filter((r) => Array.isArray(r.label) && r.label.length);
  const pool = withLabel.length ? withLabel : list;
  pool.sort((a, b) => yearOf(a) - yearOf(b));
  return pool[0];
}

/**
 * GET a Discogs API path (or absolute URL) as JSON, authenticated with a
 * personal access token. Retries on 429 honoring Retry-After (≤3×), and slows
 * down when the rate-limit budget runs low.
 */
export async function discogsFetch(path, { token, attempt = 0 } = {}) {
  if (!token) throw new Error('Discogs token required');
  const url = path.startsWith('http') ? path : `${DISCOGS_API}${path}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Authorization: `Discogs token=${token}`,
    },
  });
  if (res.status === 429) {
    if (attempt >= 3) throw new Error('Discogs rate limit exceeded (429)');
    const retryAfter = Number(res.headers.get('Retry-After')) || 2;
    await sleep((retryAfter + 1) * 1000);
    return discogsFetch(path, { token, attempt: attempt + 1 });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Discogs ${res.status}: ${body.slice(0, 200)}`);
  }
  const remaining = Number(res.headers.get('X-Discogs-Ratelimit-Remaining'));
  if (Number.isFinite(remaining) && remaining <= 2) await sleep(1500);
  return res.json();
}

function yearFrom(...vals) {
  for (const v of vals) {
    const y = parseInt(String(v ?? '').slice(0, 4), 10);
    if (Number.isFinite(y) && y > 0) return y;
  }
  return null;
}

/**
 * Enrich one song via Discogs. Returns the fields to merge onto the song doc
 * (without `enrichedAt` — the caller stamps that with a server timestamp).
 *
 *   { enrichStatus, [year], [label], [artistBio], [artistCountry], [artistTown], [discogs] }
 *
 * `delayMs` spaces out the sequential API calls (search → release → artist) to
 * stay under the per-token rate limit; pass 0 in tests.
 */
export async function enrichSong(song, token, { delayMs = 1100 } = {}) {
  if (!isEnrichable(song?.title, song?.artist)) return { enrichStatus: 'skipped' };

  const params = new URLSearchParams({
    type: 'release',
    artist: song.artist,
    track: song.title,
    per_page: '50',
  });
  const search = await discogsFetch(`/database/search?${params.toString()}`, { token });
  const picked = pickRelease(search.results);
  if (!picked || !picked.id) return { enrichStatus: 'nomatch' };

  await sleep(delayMs);
  const release = await discogsFetch(`/releases/${picked.id}`, { token });

  const releaseId = release.id || picked.id;
  const out = {
    enrichStatus: 'done',
    label: release.labels?.[0]?.name || (Array.isArray(picked.label) ? picked.label[0] : null) || null,
    // artistCountry/artistTown are parsed from the bio below — NOT release.country,
    // which is the record's pressing country (often wrong for the artist).
    artistCountry: null,
    artistTown: null,
    discogs: {
      releaseId,
      releaseUrl: `https://www.discogs.com/release/${releaseId}`,
    },
  };
  const year = yearFrom(release.year, picked.year, release.released);
  if (year) out.year = year; // overwrites the ID3 year per product decision

  const artistId = release.artists?.find((a) => a && a.id)?.id;
  if (artistId) {
    await sleep(delayMs);
    try {
      const artist = await discogsFetch(`/artists/${artistId}`, { token });
      const profile = stripBBCode(artist.profile || '');
      if (profile) out.artistBio = profile.slice(0, 600);
      const loc = parseArtistLocation(profile);
      out.artistCountry = loc.country;
      out.artistTown = loc.town;
      out.discogs.artistId = artistId;
    } catch (err) {
      // Bio is best-effort; keep the release-level enrichment even if it fails.
      console.warn('discogs artist fetch failed', err.message);
    }
  }
  return out;
}

/**
 * Resolve the Discogs token to use for a song uploaded by `authorEmail`: the
 * author's own token, else the first admin who has one. `db` is a firebase-admin
 * Firestore instance. Returns null if no token is available anywhere.
 */
export async function resolveToken(db, authorEmail) {
  const own = await readToken(db, authorEmail);
  if (own) return own;
  const admins = await db.collection('admins').get();
  for (const a of admins.docs) {
    const t = await readToken(db, a.id);
    if (t) return t;
  }
  return null;
}

async function readToken(db, email) {
  if (!email) return null;
  const snap = await db.doc(`users/${email.toLowerCase()}/private/discogs`).get();
  return snap.exists ? (snap.data().token || null) : null;
}
