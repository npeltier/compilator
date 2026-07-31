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

import { FieldValue } from 'firebase-admin/firestore';
import { normalizeArtist } from './doublons.js';
import { lookupArtistGeo } from './musicbrainz.js';

// Bump when the resolution pipeline changes in a way that should re-run. Cache
// docs and song docs carry `geoV`; anything below the current version re-resolves.
export const GEO_VERSION = 1;

// A Firestore-doc-id-safe key for an artist. normalizeArtist only lowercases +
// trims, so names like "AC/DC" keep a slash — which Firestore treats as a path
// separator (invalid as a doc id). Collapse slashes so the cache key is stable
// and legal. The backfill script mirrors this exactly.
export function artistKey(artist) {
  return normalizeArtist(artist).replace(/\//g, '_');
}

/**
 * Resolve an artist's geography, using (and populating) the artistMeta cache.
 * MusicBrainz is primary; `discogsFallback` (the bio-parsed { artistCountry,
 * artistTown } from discogs.js) is used only when MB has no confident match.
 *
 * @returns the cache doc data: { artist, country, countryCode, region,
 *   regionCode, town, source, mbid, geoV }
 */
export async function resolveArtistGeo(db, artist, discogsFallback = null, { delayMs = 1100, force = false } = {}) {
  const key = artistKey(artist);
  if (!key) return null;

  const ref = db.collection('artistMeta').doc(key);
  const snap = await ref.get();
  if (!force && snap.exists && snap.data().geoV === GEO_VERSION) return snap.data();

  let geo = null;
  try {
    geo = await lookupArtistGeo(artist, { delayMs });
  } catch (err) {
    console.warn('lookupArtistGeo failed:', err.message);
  }

  // Fall back to whatever Discogs parsed from the bio when MB gave us no country.
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
    source: geo?.source || 'none',
    mbid: geo?.mbid || null,
    geoV: GEO_VERSION,
    resolvedAt: FieldValue.serverTimestamp(),
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
    geoSource: geo?.source || 'none',
    geoV: GEO_VERSION,
  };
}
