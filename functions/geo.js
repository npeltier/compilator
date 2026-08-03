// Artist-geography resolution + caching, shared by the enrichment trigger
// (functions/index.js) and the backfill script (scripts/backfill-geo.js).
//
// Country/region/town are properties of the ARTIST, not the song, so we resolve
// each unique artist once and cache it in artistMeta/{normalizedArtist}, then fan
// the result out to that artist's songs. This keeps us well under MusicBrainz's
// 1 req/s and gives every song by an artist identical, normalized values.
//
// Takes a firebase-admin Firestore handle as a parameter (no admin import here),
// mirroring discogs.js so it stays easy to reuse and test.

import { normalizeArtist } from './doublons.js';
import { lookupArtistGeo, lookupArtistByDiscogsId } from './musicbrainz.js';

// Bump when the resolution pipeline changes in a way that should re-run. Cache
// docs and song docs carry `geoV`; anything below the current version re-resolves.
// v2: Discogs-id disambiguation (exact MB artist via the Discogs URL relation).
export const GEO_VERSION = 2;

// A name match that MusicBrainz can't tell apart from a same-named artist
// somewhere else: we store our best guess but mark it, so it shows up in
// /validate for a human call instead of passing as fact.
export const AMBIGUOUS_SOURCE = 'musicbrainz-ambiguous';

// Sources that are NOT a settled answer — a provisional doc is always re-tried.
const PROVISIONAL_SOURCES = new Set(['none', AMBIGUOUS_SOURCE]);

// `geoV` records which pipeline version last TOUCHED a doc — it does not mean the
// lookup succeeded. Done-ness is "at the current version AND we actually settled
// on something", i.e. a `'none'` or ambiguous result is never done: an artist
// that failed to resolve (no Discogs id, MusicBrainz down, a `nomatch` release
// with no bio to fall back on) or resolved to a coin-flip stays eligible for a
// retry on the next run instead of being retired forever. Both "already
// resolved?" checks — the artistMeta cache below and the song skip in
// scripts/backfill-geo.js — go through this.
// Cache docs name the field `source`, song docs `geoSource`; a doc carrying
// neither isn't ours, so treat it as unresolved (a wasted retry beats a
// permanently stranded song).
export function isGeoResolved(doc) {
  if (!doc || doc.geoV !== GEO_VERSION) return false;
  return !PROVISIONAL_SOURCES.has(doc.source ?? doc.geoSource ?? 'none');
}

// A Firestore-doc-id-safe key for an artist. normalizeArtist only lowercases +
// trims, so names like "AC/DC" keep a slash — which Firestore treats as a path
// separator (invalid as a doc id). Collapse slashes so the cache key is stable
// and legal. The backfill script mirrors this exactly.
export function artistKey(artist) {
  return normalizeArtist(artist).replace(/\//g, '_');
}

// Cache doc id. Prefer the Discogs artist id (unique per REAL artist) so two
// different artists that share a name don't collapse into one cache entry — the
// bug behind "Taxi = Romania" etc. Fall back to the normalized name.
function cacheKey(artist, discogsArtistId) {
  return discogsArtistId ? `discogs-${discogsArtistId}` : artistKey(artist);
}

// Loose country-agreement check between an MB canonical label ("Peru") and a
// Discogs-bio-parsed country (which may be a demonym/label like "Peru"/"USA").
function countriesAgree(a, b) {
  const norm = (s) => String(s || '').toLowerCase().trim();
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/**
 * Resolve an artist's geography, using (and populating) the artistMeta cache.
 *
 * Resolution order:
 *   1. Discogs id → exact MB artist (authoritative; disambiguates namesakes).
 *   2. MB name search — but rejected if its country disagrees with the Discogs
 *      bio's country (the actual record wins).
 *   3. Discogs bio-parsed country as a last resort.
 *
 * @param opts.discogsArtistId  the song's discogs.artistId (the disambiguator)
 * @param opts.discogsFallback  the discogs.js fields { artistCountry, artistTown }
 * @returns the cache doc data
 */
export async function resolveArtistGeo(db, artist, {
  discogsArtistId = null, discogsFallback = null, delayMs = 1100, force = false,
} = {}) {
  const key = cacheKey(artist, discogsArtistId);
  if (!key || key === 'discogs-') return null;

  const ref = db.collection('artistMeta').doc(key);
  const snap = await ref.get();
  if (!force && snap.exists && isGeoResolved(snap.data())) return snap.data();

  // Each step gets its OWN try/catch: a step that fails must not take the later
  // fallbacks down with it. They shared one before, so a throw in step 1 skipped
  // the name search entirely and the artist ended up with no country at all.
  let geo = null;

  // 1. Exact match via the Discogs link.
  if (discogsArtistId) {
    try {
      geo = await lookupArtistByDiscogsId(discogsArtistId, { delayMs });
    } catch (err) {
      console.warn('geo discogs-id lookup failed:', err.message);
    }
  }

  // 2. Name search, gated on agreement with the Discogs bio country.
  if (!geo || !geo.countryCode) {
    try {
      const byName = await lookupArtistGeo(artist, { delayMs });
      if (byName?.countryCode) {
        const bio = discogsFallback?.artistCountry;
        if (bio && countriesAgree(byName.country, bio)) {
          // The Discogs bio independently corroborates the pick, so a namesake
          // tie no longer matters — this is a settled answer.
          geo = { ...byName, ambiguous: false, alternatives: null };
        } else if (!bio) {
          geo = byName;
        }
        // else: distrust the ambiguous name match; fall through to the bio below.
      }
    } catch (err) {
      console.warn('geo name lookup failed:', err.message);
    }
  }

  // 3. Discogs bio-parsed country as a last resort.
  if ((!geo || !geo.countryCode) && discogsFallback?.artistCountry) {
    geo = {
      source: 'discogs-bio',
      mbid: geo?.mbid || null,
      country: discogsFallback.artistCountry,
      countryCode: null,
      region: null,
      regionCode: null,
      town: discogsFallback.artistTown || null,
    };
  }

  const data = {
    artist,
    country: geo?.country || null,
    countryCode: geo?.countryCode || null,
    region: geo?.region || null,
    regionCode: geo?.regionCode || null,
    town: geo?.town || null,
    // An unconfirmed namesake tie is recorded as provisional, keeping the guess
    // (better than a blank map) while marking it for /validate and for retry.
    source: geo?.ambiguous ? AMBIGUOUS_SOURCE : (geo?.source || 'none'),
    alternatives: geo?.alternatives || null,
    mbid: geo?.mbid || null,
    geoV: GEO_VERSION,
    // Plain Date (→ Firestore Timestamp) rather than a serverTimestamp() sentinel:
    // this module is imported by both the Cloud Function and the backfill script,
    // which load different firebase-admin copies, and a cross-copy sentinel fails
    // to serialize. resolvedAt is write-only metadata, so wall-clock time is fine.
    resolvedAt: new Date(),
  };
  await ref.set(data, { merge: true });
  return data;
}

/** Map a resolved-geo cache doc to the fields stored on a song doc. */
export function geoSongFields(geo) {
  return {
    artistCountry: geo?.country || null,
    artistCountryCode: geo?.countryCode || null,
    artistRegion: geo?.region || null,
    artistRegionCode: geo?.regionCode || null,
    artistTown: geo?.town || null,
    geoSource: geo?.ambiguous ? AMBIGUOUS_SOURCE : (geo?.source || 'none'),
    // The rival namesakes, so /validate can show an admin what to choose between.
    geoAlternatives: geo?.alternatives || null,
    geoV: GEO_VERSION,
  };
}
