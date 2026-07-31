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
 *   { source:'musicbrainz', mbid, country, countryCode, region, regionCode, town }
 * or null when there's no confident match.
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

  const out = {
    source: 'musicbrainz',
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
      // Subdivision/town are best-effort — keep the country from the search.
      console.warn('mb area lookup failed', err.message);
    }
  }
  return out;
}
