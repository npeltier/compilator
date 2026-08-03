import { jest } from '@jest/globals';

// resolveArtistGeo talks to MusicBrainz, so stub that module before importing geo.js.
const lookupArtistGeo = jest.fn();
const lookupArtistByDiscogsId = jest.fn();
jest.unstable_mockModule('../musicbrainz.js', () => ({ lookupArtistGeo, lookupArtistByDiscogsId }));

const { resolveArtistGeo, geoSongFields, isGeoResolved, GEO_VERSION } = await import('../geo.js');

// Minimal Firestore stand-in: artistMeta docs live in `docs`, keyed by doc id.
function mkDb(docs = {}) {
  const writes = [];
  return {
    writes,
    collection: () => ({
      doc: (id) => ({
        get: async () => ({ exists: docs[id] != null, data: () => docs[id] }),
        set: async (data) => { writes.push({ id, data }); docs[id] = { ...docs[id], ...data }; },
      }),
    }),
  };
}

beforeEach(() => {
  lookupArtistGeo.mockReset();
  lookupArtistByDiscogsId.mockReset();
});

describe('isGeoResolved', () => {
  test('true only at the current version with a real source', () => {
    expect(isGeoResolved({ geoV: GEO_VERSION, source: 'discogs+musicbrainz' })).toBe(true);
    expect(isGeoResolved({ geoV: GEO_VERSION, geoSource: 'discogs-bio' })).toBe(true);
  });
  test("false for a 'none' result even at the current version", () => {
    expect(isGeoResolved({ geoV: GEO_VERSION, source: 'none' })).toBe(false);
    expect(isGeoResolved({ geoV: GEO_VERSION, geoSource: 'none' })).toBe(false);
  });
  test('false for an older version, a missing source, or no doc', () => {
    expect(isGeoResolved({ geoV: GEO_VERSION - 1, source: 'musicbrainz' })).toBe(false);
    expect(isGeoResolved({ geoV: GEO_VERSION })).toBe(false);
    expect(isGeoResolved(null)).toBe(false);
  });
});

describe('resolveArtistGeo cache freshness', () => {
  test('reuses a cached hit without hitting MusicBrainz', async () => {
    const db = mkDb({ 'discogs-42': { artist: 'Taxi', country: 'Peru', countryCode: 'PE', source: 'discogs+musicbrainz', geoV: GEO_VERSION } });
    const geo = await resolveArtistGeo(db, 'Taxi', { discogsArtistId: 42 });
    expect(geo.countryCode).toBe('PE');
    expect(lookupArtistByDiscogsId).not.toHaveBeenCalled();
    expect(lookupArtistGeo).not.toHaveBeenCalled();
  });

  test("retries a cached 'none' — a failed lookup is not permanent", async () => {
    const db = mkDb({ 'discogs-42': { artist: 'Taxi', source: 'none', geoV: GEO_VERSION } });
    lookupArtistByDiscogsId.mockResolvedValue({ source: 'discogs+musicbrainz', country: 'Peru', countryCode: 'PE' });
    const geo = await resolveArtistGeo(db, 'Taxi', { discogsArtistId: 42 });
    expect(lookupArtistByDiscogsId).toHaveBeenCalledWith(42, expect.anything());
    expect(geo.countryCode).toBe('PE');
    expect(geo.source).toBe('discogs+musicbrainz');
  });

  test("a still-failing retry stays retryable (source 'none' at the current version)", async () => {
    const db = mkDb();
    lookupArtistByDiscogsId.mockResolvedValue(null);
    lookupArtistGeo.mockResolvedValue(null);
    const geo = await resolveArtistGeo(db, 'Unknown Band', { discogsArtistId: 7 });
    expect(geo.source).toBe('none');
    expect(isGeoResolved(geo)).toBe(false);
    expect(isGeoResolved(geoSongFields(geo))).toBe(false);
  });
});

describe('geoSongFields', () => {
  test('a resolved artist reads as done', () => {
    const fields = geoSongFields({ source: 'musicbrainz', country: 'Germany', countryCode: 'DE' });
    expect(fields).toMatchObject({ artistCountry: 'Germany', artistCountryCode: 'DE', geoSource: 'musicbrainz', geoV: GEO_VERSION });
    expect(isGeoResolved(fields)).toBe(true);
  });
  test('null geo nulls every field and reads as not done', () => {
    const fields = geoSongFields(null);
    expect(fields.artistCountry).toBeNull();
    expect(fields.geoSource).toBe('none');
    expect(isGeoResolved(fields)).toBe(false);
  });
});
