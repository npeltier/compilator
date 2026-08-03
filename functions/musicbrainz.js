// MusicBrainz artist-geography lookup. Given an artist name, resolve the
// artist's ORIGIN: country (+ ISO-3166-1 alpha-2), region/subdivision (+
// ISO-3166-2, e.g. US-MI), and town. Structured data — far better coverage and
// normalization than parsing prose bios, which is what browse-by-country/region
// needs.
//
// Dependency-light on purpose (no firebase-admin) so it can be unit-tested in
// isolation and reused by both the enrichment trigger and the backfill script.
// HTTP goes through the global fetch (Node 18+).
//
// Etiquette: MusicBrainz requires a descriptive User-Agent and asks for ≤1
// request/second. Callers serialize (the enrich worker is maxInstances:1; the
// backfill sleeps between artists) and `delayMs` spaces the two calls per lookup.

import { normalizeArtist } from './doublons.js';

const MB_API = 'https://musicbrainz.org/ws/2';
const USER_AGENT = 'Compilator/1.0 (+https://compilator-83816.web.app)';
const MIN_SCORE = 90; // MB search score (0-100); below this a match is a guess
// A rival namesake within this many points of the winner makes the pick a
// coin-flip. Real case: "Soapbox" scores SE 100 / Glasgow 98 / DE 97 — the
// search score reflects text similarity and popularity, not which band is on the
// compilation, so we surface the tie instead of silently trusting the top hit.
const AMBIGUITY_GAP = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ISO-3166-1 alpha-2 → English country name, via the platform's own table.
let regionNames = null;
export function countryLabel(code) {
  if (!code) return null;
  try {
    regionNames ||= new Intl.DisplayNames(['en'], { type: 'region' });
    return regionNames.of(code) || null;
  } catch {
    return null;
  }
}

/**
 * GET a MusicBrainz API path as JSON. Retries on 503 (MB's "slow down / busy"
 * signal) up to 3×; throws on other non-2xx.
 */
export async function mbFetch(path, { attempt = 0 } = {}) {
  const url = path.startsWith('http') ? path : `${MB_API}${path}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (res.status === 503) {
    if (attempt >= 3) throw new Error('MusicBrainz 503 (rate limited)');
    await sleep((attempt + 1) * 1500);
    return mbFetch(path, { attempt: attempt + 1 });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MusicBrainz ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Choose the best artist match: an exact (normalized) name wins, then highest
 * search score. Returns null when the top score is below the confidence floor.
 */
export function pickArtist(results, name) {
  const list = (results || []).filter(Boolean);
  if (!list.length) return null;
  const target = normalizeArtist(name);
  const scored = list.map((a) => ({
    a,
    score: Number(a.score) || 0,
    exact: normalizeArtist(a.name) === target ? 1 : 0,
  }));
  scored.sort((x, y) => (y.exact - x.exact) || (y.score - x.score));
  const best = scored[0];
  return best && best.score >= MIN_SCORE ? best.a : null;
}

/** Human-readable candidate label for the /validate screen: "SOAPBOX — Glasgow (Scottish punk band)". */
export function describeCandidate(a) {
  const where = a?.area?.name || countryLabel(a?.country) || '?';
  const extra = a?.disambiguation ? ` (${a.disambiguation})` : '';
  return `${a?.name || '?'} — ${where}${extra}`;
}

/**
 * Rival candidates that make `chosen` a coin-flip: same name (true namesakes,
 * not "Soapbox Symphony"), within AMBIGUITY_GAP points, and pointing at
 * DIFFERENT geography — a near-tie that agrees on the country is harmless, since
 * the country is all we store.
 */
export function namesakeRivals(results, name, chosen) {
  if (!chosen) return [];
  const target = normalizeArtist(name);
  const floor = (Number(chosen.score) || 0) - AMBIGUITY_GAP;
  const chosenCode = chosen.country || null;
  const chosenArea = chosen.area?.name || null;
  return (results || []).filter(Boolean).filter((a) => {
    if (a === chosen || (a.id && a.id === chosen.id)) return false;
    if (normalizeArtist(a.name) !== target) return false;
    if ((Number(a.score) || 0) < floor) return false;
    const code = a.country || null;
    // Compare countries when both are known; otherwise fall back to area names
    // (MB often leaves `country` empty but names the city, as with Glasgow).
    if (code && chosenCode) return code !== chosenCode;
    return (a.area?.name || '') !== (chosenArea || '');
  });
}

/**
 * Reduce an MB area entity (plus its "part of" relations) to geo fields. An area
 * is a Country, a Subdivision (state/province), or a City/Municipality/District;
 * a city's parent subdivision arrives as a "part of" relation.
 */
export function classifyArea(area) {
  const out = { country: null, countryCode: null, region: null, regionCode: null, town: null };
  if (!area) return out;
  const apply = (a, isSelf) => {
    if (!a) return;
    const type = a.type || '';
    const iso1 = a['iso-3166-1-codes']?.[0] || null;
    const iso2 = a['iso-3166-2-codes']?.[0] || null;
    if (type === 'Country' || iso1) {
      out.countryCode ||= iso1;
      out.country ||= countryLabel(iso1) || a.name || null;
    } else if (type === 'Subdivision' || iso2) {
      out.region ||= a.name || null;
      out.regionCode ||= iso2;
    } else if (['City', 'Municipality', 'District', 'Borough'].includes(type)) {
      out.town ||= a.name || null;
    } else if (isSelf && !out.town) {
      // Unknown type on the begin-area itself — usually a city.
      out.town = a.name || null;
    }
  };
  apply(area, true);
  for (const rel of area.relations || []) {
    if (rel.type === 'part of' && rel.area) apply(rel.area, false);
  }
  return out;
}

/**
 * Look up an artist's geography on MusicBrainz. Returns
 *   { source:'musicbrainz', mbid, country, countryCode, region, regionCode, town,
 *     ambiguous?, alternatives? }
 * or null when there's no confident match.
 *
 * `ambiguous` flags a near-tie between same-named artists from different places:
 * the geo is our best guess, but a human should confirm it (see /validate). The
 * rivals come out of the search response we already have — no extra request.
 *
 * Two requests: artist search (MBID + country) and a begin-area lookup with area
 * relations (subdivision + town). `delayMs` spaces them to respect the 1 req/s
 * guidance; pass 0 in tests.
 */
export async function lookupArtistGeo(name, { delayMs = 1100 } = {}) {
  if (!name || !normalizeArtist(name)) return null;
  const q = encodeURIComponent(`artist:"${String(name).replace(/"/g, '')}"`);
  const search = await mbFetch(`/artist?query=${q}&limit=5&fmt=json`);
  const artist = pickArtist(search.artists, name);
  if (!artist) return null;
  const rivals = namesakeRivals(search.artists, name, artist);
  const geo = await geoFromArtist(artist, 'musicbrainz', { delayMs });
  if (rivals.length) {
    geo.ambiguous = true;
    geo.alternatives = rivals.slice(0, 3).map(describeCandidate);
  }
  return geo;
}

/**
 * The reliable disambiguator: resolve the EXACT MusicBrainz artist linked to a
 * Discogs artist id via MB's URL relationship, then read its geography. This is
 * how Discogs "validates" the match — the Discogs release pins the real artist,
 * so same-named namesakes (two "Taxi"s, two "EV"s…) can't be confused.
 *
 * Returns the geo fields (source 'discogs+musicbrainz'), or null if MB has no
 * artist linked to that Discogs id.
 */
export async function lookupArtistByDiscogsId(discogsArtistId, { delayMs = 1100 } = {}) {
  if (!discogsArtistId) return null;
  // Canonical numeric form (what we store); MB indexes this exact URL.
  const resource = `https://www.discogs.com/artist/${discogsArtistId}`;
  const data = await mbFetch(`/url?resource=${encodeURIComponent(resource)}&inc=artist-rels&fmt=json`);
  const rels = (data.relations || []).filter((r) => r.artist);
  if (!rels.length) return null;
  // Prefer a linked artist that carries a country.
  const stub = rels.find((r) => r.artist.country) || rels[0];
  if (!stub.artist.id) return null;
  // The relation stub omits begin-area — fetch the full artist for area details.
  await sleep(delayMs);
  let artist = stub.artist;
  try { artist = await mbFetch(`/artist/${stub.artist.id}?fmt=json`); } catch (_) { /* fall back to stub */ }
  return geoFromArtist(artist, 'discogs+musicbrainz', { delayMs });
}

/**
 * Reduce a full MB artist object (with `country` + `area`/`begin-area`) to geo
 * fields, resolving the begin-area for subdivision + town (one extra request).
 */
async function geoFromArtist(artist, source, { delayMs = 1100 } = {}) {
  const out = {
    source,
    mbid: artist.id || null,
    countryCode: artist.country || null,
    country: countryLabel(artist.country) || null,
    region: null,
    regionCode: null,
    town: null,
  };
  const beginId = artist['begin-area']?.id || artist.area?.id || null;
  if (beginId) {
    await sleep(delayMs);
    try {
      const area = await mbFetch(`/area/${beginId}?inc=area-rels&fmt=json`);
      const geo = classifyArea(area);
      out.town = geo.town;
      out.region = geo.region;
      out.regionCode = geo.regionCode;
      out.country ||= geo.country;
      out.countryCode ||= geo.countryCode;
    } catch (err) {
      // Subdivision/town are best-effort — keep the country we already have.
      console.warn('mb area lookup failed', err.message);
    }
  }
  return out;
}
