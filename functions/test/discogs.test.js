import { jest } from '@jest/globals';

const {
  isEnrichable,
  isVariousArtist,
  stripBBCode,
  parseArtistLocation,
  pickRelease,
  enrichSong,
  resolveToken,
} = await import('../discogs.js');

describe('isEnrichable / isVariousArtist', () => {
  test('rejects untitled tracks', () => {
    expect(isEnrichable('Sans titre', 'Bowie')).toBe(false);
    expect(isEnrichable('  sans TITRE ', 'Bowie')).toBe(false);
    expect(isEnrichable('', 'Bowie')).toBe(false);
    expect(isEnrichable(null, 'Bowie')).toBe(false);
  });

  test('rejects various / empty artists', () => {
    for (const a of ['Various', 'various artists', 'VA', 'V/A', 'Artistes divers', 'Divers', 'Compilation', 'Multi-Interprètes']) {
      expect(isEnrichable('Heroes', a)).toBe(false);
      expect(isVariousArtist(a)).toBe(true);
    }
    expect(isEnrichable('Heroes', '')).toBe(false);
    expect(isEnrichable('Heroes', null)).toBe(false);
  });

  test('accepts a real title + artist', () => {
    expect(isEnrichable('Heroes', 'David Bowie')).toBe(true);
    expect(isVariousArtist('David Bowie')).toBe(false);
  });
});

describe('stripBBCode', () => {
  test('keeps names/text and drops markup', () => {
    expect(stripBBCode('[b]Hello[/b] world')).toBe('Hello world');
    expect(stripBBCode('Member of [a=The Beatles].')).toBe('Member of The Beatles.');
    expect(stripBBCode('See [url=http://x.com]here[/url].')).toBe('See here.');
    expect(stripBBCode('Ref [a123] and [l456] gone')).toBe('Ref  and  gone'.replace(/\s{2,}/g, ' '));
    expect(stripBBCode('')).toBe('');
    expect(stripBBCode(null)).toBe('');
  });
});

describe('parseArtistLocation', () => {
  test('extracts town + country from a "Born … in …" bio', () => {
    expect(parseArtistLocation('Born: 8 January 1947 in Brixton, London, England, UK.'))
      .toEqual({ town: 'Brixton', country: 'UK' });
  });

  test('extracts from a "from …" bio and collapses "A and B" towns', () => {
    expect(parseArtistLocation('Tuareg musician from Tchintabaraden and Abalak, Niger.'))
      .toEqual({ town: 'Tchintabaraden', country: 'Niger' });
  });

  test('single-segment location is treated as country only', () => {
    expect(parseArtistLocation('Reggae band from Jamaica.'))
      .toEqual({ town: null, country: 'Jamaica' });
  });

  test('ignores non-location "from" phrases', () => {
    expect(parseArtistLocation('Active from the 1970s onward.'))
      .toEqual({ town: null, country: null });
    expect(parseArtistLocation('')).toEqual({ town: null, country: null });
  });

  test('extended: "born …, <Town>" (no "in") + leading demonym for country', () => {
    expect(parseArtistLocation('Jamaican pioneering ska and reggae singer, born 26 June 1942, Kingston – died 11 June 2026.'))
      .toEqual({ town: 'Kingston', country: 'Jamaica' });
  });

  test('extended: demonym fills country when no place phrase', () => {
    expect(parseArtistLocation('American rapper and producer.'))
      .toEqual({ town: null, country: 'USA' });
    expect(parseArtistLocation('A South African jazz pianist.'))
      .toEqual({ town: null, country: 'South Africa' });
  });

  test('extended: phrase country still wins over demonym', () => {
    // "British" demonym present, but the explicit place phrase is authoritative.
    expect(parseArtistLocation('British musician, based in Berlin, Germany.'))
      .toEqual({ town: 'Berlin', country: 'Germany' });
  });

  test('rejects genre-range "from X to Y" false positives', () => {
    expect(parseArtistLocation('Music ranging from Electronica to Bossa Nova to Acoustic.'))
      .toEqual({ town: null, country: null });
  });

  test('rejects over-capture with "to", falls back to demonym for country', () => {
    // The "in Pierrefonds, Canada to French parents" capture contains "to" and is
    // rejected (so is the messy born-comma candidate); country comes from "French".
    expect(parseArtistLocation('French singer, born 12 September 1961 in Pierrefonds, Canada to French parents.'))
      .toEqual({ town: null, country: 'France' });
  });
});

describe('pickRelease', () => {
  test('prefers earliest year that has a label', () => {
    const r = pickRelease([
      { id: 1, year: '1980', label: ['Reissue Co'] },
      { id: 2, year: '1977', label: ['RCA'] },
      { id: 3, year: '1975' }, // no label
    ]);
    expect(r.id).toBe(2);
  });

  test('falls back to any result when none have labels', () => {
    const r = pickRelease([{ id: 9, year: '1990' }, { id: 8, year: '1985' }]);
    expect(r.id).toBe(8);
  });

  test('returns null on empty', () => {
    expect(pickRelease([])).toBeNull();
    expect(pickRelease(null)).toBeNull();
  });
});

describe('enrichSong', () => {
  afterEach(() => { delete global.fetch; });

  function mockFetchSequence(responses) {
    const calls = [];
    global.fetch = jest.fn(async (url) => {
      calls.push(url);
      const body = responses.shift();
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => body,
        text: async () => '',
      };
    });
    return calls;
  }

  test('skips a various-artist song without any HTTP call', async () => {
    global.fetch = jest.fn();
    const out = await enrichSong({ title: 'X', artist: 'Various' }, 'tok', { delayMs: 0 });
    expect(out).toEqual({ enrichStatus: 'skipped' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('nomatch when search returns nothing', async () => {
    mockFetchSequence([{ results: [] }]);
    const out = await enrichSong({ title: 'Heroes', artist: 'David Bowie' }, 'tok', { delayMs: 0 });
    expect(out).toEqual({ enrichStatus: 'nomatch' });
  });

  test('happy path: year/label, country+town parsed from bio, release link', async () => {
    const calls = mockFetchSequence([
      // search result carries a US pressing country — which we deliberately ignore.
      { results: [{ id: 42, year: '1977', label: ['RCA'], country: 'US' }] },
      { id: 42, year: 1977, country: 'US', labels: [{ name: 'RCA Victor' }], artists: [{ id: 7, name: 'David Bowie' }] },
      { id: 7, profile: 'Born: 8 January 1947 in Brixton, London, England, UK. Member of [a=Tin Machine].' },
    ]);
    const out = await enrichSong({ title: 'Heroes', artist: 'David Bowie', year: 1999 }, 'tok', { delayMs: 0 });
    expect(out.enrichStatus).toBe('done');
    expect(out.year).toBe(1977); // overwrites ID3 year
    expect(out.label).toBe('RCA Victor');
    // country/town come from the bio, NOT the US pressing country.
    expect(out.artistCountry).toBe('UK');
    expect(out.artistTown).toBe('Brixton');
    expect(out.artistBio).toContain('Born: 8 January 1947 in Brixton, London, England, UK. Member of Tin Machine.');
    expect(out.discogs).toEqual({ releaseId: 42, releaseUrl: 'https://www.discogs.com/release/42', artistId: 7 });
    // search → release → artist
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain('/database/search?');
    expect(calls[1]).toContain('/releases/42');
    expect(calls[2]).toContain('/artists/7');
  });

  test('keeps release-level data when artist bio fetch fails', async () => {
    let n = 0;
    global.fetch = jest.fn(async (url) => {
      n++;
      if (n === 1) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ results: [{ id: 5, year: '1965', label: ['Stax'] }] }) };
      if (n === 2) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: 5, year: 1965, country: 'US', labels: [{ name: 'Stax' }], artists: [{ id: 3 }] }) };
      return { ok: false, status: 500, headers: { get: () => null }, text: async () => 'boom' };
    });
    const out = await enrichSong({ title: 'Song', artist: 'Artist' }, 'tok', { delayMs: 0 });
    expect(out.enrichStatus).toBe('done');
    expect(out.label).toBe('Stax');
    expect(out.year).toBe(1965);
    expect(out.artistBio).toBeUndefined();
  });
});

describe('resolveToken', () => {
  function mkDb({ tokens = {}, admins = [] }) {
    return {
      doc: (path) => ({
        get: async () => {
          const token = tokens[path];
          return { exists: token != null, data: () => ({ token }) };
        },
      }),
      collection: () => ({
        get: async () => ({ docs: admins.map((id) => ({ id })) }),
      }),
    };
  }

  test('returns the author own token', async () => {
    const db = mkDb({ tokens: { 'users/me@x.com/private/discogs': 'MINE' } });
    expect(await resolveToken(db, 'Me@x.com')).toBe('MINE');
  });

  test('falls back to first admin with a token', async () => {
    const db = mkDb({
      tokens: { 'users/admin2@x.com/private/discogs': 'ADMIN2' },
      admins: ['admin1@x.com', 'admin2@x.com'],
    });
    expect(await resolveToken(db, 'nobody@x.com')).toBe('ADMIN2');
  });

  test('returns null when nobody has a token', async () => {
    const db = mkDb({ admins: ['admin1@x.com'] });
    expect(await resolveToken(db, 'nobody@x.com')).toBeNull();
  });
});
