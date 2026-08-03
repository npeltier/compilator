import { jest } from '@jest/globals';

const {
  countryLabel,
  pickArtist,
  classifyArea,
  lookupArtistGeo,
  lookupArtistByDiscogsId,
} = await import('../musicbrainz.js');

describe('countryLabel', () => {
  test('maps ISO-3166-1 alpha-2 to an English name', () => {
    expect(countryLabel('US')).toBe('United States');
    expect(countryLabel('GB')).toBe('United Kingdom');
    expect(countryLabel('FR')).toBe('France');
  });
  test('returns null for empty / unknown', () => {
    expect(countryLabel(null)).toBeNull();
    expect(countryLabel('')).toBeNull();
  });
});

describe('pickArtist', () => {
  test('prefers an exact normalized name over a higher score', () => {
    const best = pickArtist([
      { name: 'The Beatles Tribute', score: 100 },
      { name: 'Beatles', score: 95 },
    ], 'Beatles');
    expect(best.name).toBe('Beatles');
  });
  test('falls back to highest score when no exact match', () => {
    const best = pickArtist([
      { name: 'Something', score: 92 },
      { name: 'Other', score: 97 },
    ], 'Nomatch Here');
    expect(best.name).toBe('Other');
  });
  test('rejects low-confidence matches (< 90)', () => {
    expect(pickArtist([{ name: 'X', score: 60 }], 'X y z')).toBeNull();
    expect(pickArtist([], 'Anything')).toBeNull();
  });
});

describe('classifyArea', () => {
  test('extracts town + parent subdivision + country from a city area', () => {
    const area = {
      name: 'Detroit',
      type: 'City',
      relations: [
        { type: 'part of', area: { name: 'Michigan', type: 'Subdivision', 'iso-3166-2-codes': ['US-MI'] } },
        { type: 'part of', area: { name: 'United States', type: 'Country', 'iso-3166-1-codes': ['US'] } },
      ],
    };
    expect(classifyArea(area)).toEqual({
      country: 'United States', countryCode: 'US', region: 'Michigan', regionCode: 'US-MI', town: 'Detroit',
    });
  });

  test('a subdivision area sets region + code', () => {
    const area = { name: 'Bavaria', type: 'Subdivision', 'iso-3166-2-codes': ['DE-BY'] };
    const out = classifyArea(area);
    expect(out.region).toBe('Bavaria');
    expect(out.regionCode).toBe('DE-BY');
  });

  test('unknown-type self area is treated as a town', () => {
    expect(classifyArea({ name: 'Someplace' }).town).toBe('Someplace');
  });

  test('null area yields all-null fields', () => {
    expect(classifyArea(null)).toEqual({ country: null, countryCode: null, region: null, regionCode: null, town: null });
  });
});

describe('lookupArtistGeo', () => {
  afterEach(() => { delete global.fetch; });

  const jsonRes = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

  test('resolves country + region + town from search then area lookup', async () => {
    global.fetch = jest.fn(async (url) => {
      if (url.includes('/artist?query=')) {
        return jsonRes({
          artists: [{
            id: 'mbid-1', name: 'The White Stripes', score: 100, country: 'US',
            'begin-area': { id: 'area-detroit', name: 'Detroit' },
          }],
        });
      }
      if (url.includes('/area/area-detroit')) {
        return jsonRes({
          name: 'Detroit', type: 'City',
          relations: [
            { type: 'part of', area: { name: 'Michigan', type: 'Subdivision', 'iso-3166-2-codes': ['US-MI'] } },
          ],
        });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const geo = await lookupArtistGeo('The White Stripes', { delayMs: 0 });
    expect(geo).toEqual({
      source: 'musicbrainz', mbid: 'mbid-1',
      country: 'United States', countryCode: 'US',
      region: 'Michigan', regionCode: 'US-MI', town: 'Detroit',
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('returns null when there is no confident match', async () => {
    global.fetch = jest.fn(async () => jsonRes({ artists: [{ name: 'Whatever', score: 40 }] }));
    expect(await lookupArtistGeo('Totally Unknown Artist', { delayMs: 0 })).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(1); // no area lookup on a miss
  });

  test('keeps the search country when the area lookup fails', async () => {
    global.fetch = jest.fn(async (url) => {
      if (url.includes('/artist?query=')) {
        return jsonRes({ artists: [{ id: 'm', name: 'Air', score: 100, country: 'FR', 'begin-area': { id: 'a' } }] });
      }
      return { ok: false, status: 500, text: async () => 'boom', json: async () => ({}) };
    });
    const geo = await lookupArtistGeo('Air', { delayMs: 0 });
    expect(geo.country).toBe('France');
    expect(geo.countryCode).toBe('FR');
    expect(geo.region).toBeNull();
  });
});

describe('lookupArtistByDiscogsId', () => {
  afterEach(() => { delete global.fetch; });
  const jsonRes = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

  test('resolves the exact MB artist linked to the Discogs id (disambiguates namesakes)', async () => {
    global.fetch = jest.fn(async (url) => {
      if (url.includes('/url?resource=')) {
        // MB must be queried by the canonical numeric Discogs URL.
        expect(decodeURIComponent(url)).toContain('https://www.discogs.com/artist/12345');
        return jsonRes({ relations: [{ artist: { id: 'mbid-peru', name: 'Taxi', country: 'PE' } }] });
      }
      if (url.includes('/artist/mbid-peru')) {
        return jsonRes({ id: 'mbid-peru', name: 'Taxi', country: 'PE', 'begin-area': { id: 'area-lima' } });
      }
      if (url.includes('/area/area-lima')) {
        return jsonRes({ name: 'Lima', type: 'City' });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const geo = await lookupArtistByDiscogsId('12345', { delayMs: 0 });
    expect(geo.source).toBe('discogs+musicbrainz');
    expect(geo.countryCode).toBe('PE');
    expect(geo.country).toBe('Peru');
    expect(geo.town).toBe('Lima');
  });

  test('returns null when no MB artist is linked to the Discogs id', async () => {
    global.fetch = jest.fn(async () => jsonRes({ relations: [] }));
    expect(await lookupArtistByDiscogsId('999', { delayMs: 0 })).toBeNull();
  });

  test('null id short-circuits without a request', async () => {
    global.fetch = jest.fn();
    expect(await lookupArtistByDiscogsId(null, { delayMs: 0 })).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
