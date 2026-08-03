import { jest } from '@jest/globals';

const {
  countryLabel,
  pickArtist,
  classifyArea,
  lookupArtistGeo,
  lookupArtistByDiscogsId,
  namesakeRivals,
  describeCandidate,
} = await import('../musicbrainz.js');

// The real "Soapbox" search response: the Swedish band outscores the Glasgow one
// that's actually on the compilation, which is why score alone can't be trusted.
const SOAPBOX_RESULTS = [
  { id: 'se', name: 'Soapbox', score: 100, country: 'SE', area: { name: 'Sweden' }, disambiguation: 'Swedish christian punk/metal band' },
  { id: 'gb', name: 'SOAPBOX', score: 98, area: { name: 'Glasgow' }, disambiguation: 'Scottish punk band' },
  { id: 'de', name: 'Soapbox', score: 97, country: 'DE', area: { name: 'Germany' }, disambiguation: 'German band' },
  { id: 'sym', name: 'Soapbox Symphony', score: 89 },
];

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

  test('flags a near-tie between namesakes from different places', async () => {
    global.fetch = jest.fn(async (url) => {
      if (url.includes('/artist?query=')) return jsonRes({ artists: SOAPBOX_RESULTS });
      throw new Error(`unexpected url ${url}`);
    });
    const geo = await lookupArtistGeo('SOAPBOX', { delayMs: 0 });
    // Still returns the best guess — but marked, and with the rivals attached.
    expect(geo.countryCode).toBe('SE');
    expect(geo.ambiguous).toBe(true);
    expect(geo.alternatives).toEqual([
      'SOAPBOX — Glasgow (Scottish punk band)',
      'Soapbox — Germany (German band)',
    ]);
  });

  test('does not flag a clear winner', async () => {
    global.fetch = jest.fn(async (url) => {
      if (url.includes('/artist?query=')) {
        return jsonRes({ artists: [
          { id: 'a', name: 'Igorrr', score: 100, country: 'FR', area: { name: 'France' } },
          { id: 'b', name: 'Igorrr', score: 82, country: 'BE', area: { name: 'Belgium' } },
        ] });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const geo = await lookupArtistGeo('Igorrr', { delayMs: 0 });
    expect(geo.countryCode).toBe('FR');
    expect(geo.ambiguous).toBeUndefined();
    expect(geo.alternatives).toBeUndefined();
  });
});

describe('lookupArtistByDiscogsId 404 handling', () => {
  afterEach(() => { delete global.fetch; });

  test('returns null (does not throw) when MB holds no URL entity', async () => {
    // MB answers 404, not an empty result, for a Discogs URL it doesn't know.
    global.fetch = jest.fn(async () => ({
      ok: false, status: 404,
      text: async () => '{"error":"Not Found"}',
      json: async () => ({ error: 'Not Found' }),
    }));
    await expect(lookupArtistByDiscogsId(3101298, { delayMs: 0 })).resolves.toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('still throws on a real server error', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false, status: 500, text: async () => 'boom', json: async () => ({}),
    }));
    await expect(lookupArtistByDiscogsId(1, { delayMs: 0 })).rejects.toThrow(/500/);
  });
});

describe('namesakeRivals', () => {
  const rivalIds = (name, chosenId) => namesakeRivals(
    SOAPBOX_RESULTS, name, SOAPBOX_RESULTS.find((a) => a.id === chosenId),
  ).map((a) => a.id);

  test('counts same-named near-ties pointing elsewhere', () => {
    expect(rivalIds('Soapbox', 'se')).toEqual(['gb', 'de']);
  });

  test('ignores a different name, even at a close score', () => {
    // "Soapbox Symphony" (89) is a different band, not a namesake.
    expect(rivalIds('Soapbox', 'se')).not.toContain('sym');
  });

  test('ignores a namesake that agrees on the country', () => {
    const results = [
      { id: 'a', name: 'Trio', score: 100, country: 'DE', area: { name: 'Germany' } },
      { id: 'b', name: 'Trio', score: 99, country: 'DE', area: { name: 'Germany' } },
    ];
    expect(namesakeRivals(results, 'Trio', results[0])).toEqual([]);
  });

  test('flags a credible rival even 10 points behind (the EV case)', () => {
    // France scores 100, the correct UK producer 90 — the spread says nothing
    // about which band is on the compilation, so it's still a coin-flip.
    const results = [
      { id: 'fr', name: 'EV', score: 100, country: 'FR', area: { name: 'France' } },
      { id: 'gb', name: 'EV', score: 90, area: { name: 'Bury St Edmunds' }, disambiguation: 'UK artist/songwriter/producer' },
    ];
    expect(namesakeRivals(results, 'EV', results[0]).map((a) => a.id)).toEqual(['gb']);
  });

  test('ignores a rival below the confidence floor', () => {
    const results = [
      { id: 'a', name: 'Igorrr', score: 100, country: 'FR', area: { name: 'France' } },
      { id: 'b', name: 'Igorrr', score: 89, country: 'BE', area: { name: 'Belgium' } },
    ];
    expect(namesakeRivals(results, 'Igorrr', results[0])).toEqual([]);
  });

  test('ignores a distant score and handles no candidates', () => {
    const results = [
      { id: 'a', name: 'Trio', score: 100, country: 'DE' },
      { id: 'b', name: 'Trio', score: 60, country: 'US' },
    ];
    expect(namesakeRivals(results, 'Trio', results[0])).toEqual([]);
    expect(namesakeRivals([], 'Trio', null)).toEqual([]);
    expect(namesakeRivals(null, 'Trio', results[0])).toEqual([]);
  });
});

describe('describeCandidate', () => {
  test('prefers the area name, falls back to the country label', () => {
    expect(describeCandidate({ name: 'SOAPBOX', area: { name: 'Glasgow' }, disambiguation: 'Scottish punk band' }))
      .toBe('SOAPBOX — Glasgow (Scottish punk band)');
    expect(describeCandidate({ name: 'Trio', country: 'DE' })).toBe('Trio — Germany');
    expect(describeCandidate({ name: 'Nowhere' })).toBe('Nowhere — ?');
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
