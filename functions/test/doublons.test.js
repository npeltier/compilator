import { jest } from '@jest/globals';

import {
  computeDoublonsForSong,
  findAndUpdateDoublons,
  normalizeArtist,
  recomputeDoublonsForCompilation,
  recomputeDoublonsForSeeds,
  rebuildAllDoublons,
  updateDoublonsAfterReplace,
} from '../doublons.js';

// A song row as the collection-group query yields it: doublons.js reaches the
// owning compilation through `ref.parent.parent.id`.
function songDoc(compilationId, id, data) {
  const ref = { path: `${compilationId}/${id}`, parent: { parent: { id: compilationId } } };
  return { id, ref, data: () => data };
}

// Minimal Firestore stand-in. `writes` records every bulkWriter.set so tests can
// assert both *which* songs were rewritten and what they got.
function fakeDb(docs) {
  const writes = [];
  const perComp = (compilationId) => docs.filter((d) => d.ref.parent.parent.id === compilationId);
  return {
    writes,
    collectionGroup: () => ({
      get: async () => ({ forEach: (cb) => docs.forEach(cb), empty: docs.length === 0 }),
    }),
    collection: () => ({
      doc: (compilationId) => ({
        collection: () => ({ get: async () => ({ docs: perComp(compilationId) }) }),
      }),
    }),
    bulkWriter: () => ({
      set: (ref, patch) => { writes.push({ path: ref.path, patch }); },
      close: async () => {},
    }),
  };
}

const written = (db, path) => db.writes.filter((w) => w.path === path).at(-1)?.patch.doublons;

describe('normalizeArtist', () => {
  test('lowercases and trims; nullish becomes empty', () => {
    expect(normalizeArtist('  Miles Davis ')).toBe('miles davis');
    expect(normalizeArtist(null)).toBe('');
  });
});

describe('computeDoublonsForSong', () => {
  const all = [
    { id: 's1', compilationId: 'c1', hash: 'h1', artist: 'Nina Simone' },
    { id: 's2', compilationId: 'c2', hash: 'h1', artist: 'Nina Simone' },
    { id: 's3', compilationId: 'c3', hash: 'h9', artist: 'nina simone' },
    { id: 's4', compilationId: 'c4', hash: 'h8', artist: 'Autre' },
  ];

  test('same hash lands in sameTrack and is excluded from sameArtist', () => {
    const { sameTrack, sameArtist } = computeDoublonsForSong(all, all[0]);
    expect(sameTrack).toEqual([{ compilationId: 'c2', songId: 's2' }]);
    expect(sameArtist).toEqual([{ compilationId: 'c3', songId: 's3' }]);
  });

  test('artist match is case/whitespace insensitive', () => {
    const { sameArtist } = computeDoublonsForSong(all, all[2]);
    expect(sameArtist).toEqual([
      { compilationId: 'c1', songId: 's1' },
      { compilationId: 'c2', songId: 's2' },
    ]);
  });

  test('a song with no artist gets no sameArtist matches', () => {
    const target = { id: 'x', compilationId: 'c5', hash: 'hx', artist: null };
    expect(computeDoublonsForSong([...all, target], target)).toEqual({ sameTrack: [], sameArtist: [] });
  });

  test('the same song in two compilations is a doublon of itself', () => {
    const a = { id: 's1', compilationId: 'c1', hash: 'h', artist: 'A' };
    const b = { id: 's1', compilationId: 'c2', hash: 'h', artist: 'A' };
    // Same doc id, different compilation → must not be skipped as "self".
    expect(computeDoublonsForSong([a, b], a).sameTrack).toEqual([{ compilationId: 'c2', songId: 's1' }]);
  });
});

describe('findAndUpdateDoublons', () => {
  test('writes the new song and back-fills the songs it now duplicates', async () => {
    const db = fakeDb([
      songDoc('c1', 'new', { hash: 'h1', artist: 'Nina Simone' }),
      songDoc('c2', 'old', { hash: 'h1', artist: 'Nina Simone' }),
      songDoc('c3', 'other', { hash: 'h2', artist: 'Nina Simone' }),
      songDoc('c4', 'unrelated', { hash: 'h3', artist: 'Personne' }),
    ]);

    await findAndUpdateDoublons(db, 'c1', 'new', 'h1', 'Nina Simone');

    // The unrelated song is left alone — no needless writes.
    expect(db.writes.map((w) => w.path).sort()).toEqual(['c1/new', 'c2/old', 'c3/other']);
    expect(written(db, 'c1/new')).toEqual({
      sameTrack: [{ compilationId: 'c2', songId: 'old' }],
      sameArtist: [{ compilationId: 'c3', songId: 'other' }],
    });
    // The pre-existing song gains a chip pointing back at the newcomer.
    expect(written(db, 'c2/old').sameTrack).toEqual([{ compilationId: 'c1', songId: 'new' }]);
  });

  test('a song with no doublons still gets explicit empty arrays', async () => {
    const db = fakeDb([songDoc('c1', 'lonely', { hash: 'h1', artist: 'Seul' })]);
    await findAndUpdateDoublons(db, 'c1', 'lonely', 'h1', 'Seul');
    expect(written(db, 'c1/lonely')).toEqual({ sameTrack: [], sameArtist: [] });
  });
});

describe('updateDoublonsAfterReplace', () => {
  test('refreshes the songs on the old hash as well as the new one', async () => {
    // 'target' was just re-uploaded: it hashed to hOld (shared with 'wasTwin')
    // and now hashes to hNew (shared with 'nowTwin'). Both of those need their
    // sameTrack rewritten — the old twin is only reachable via the old hash.
    const db = fakeDb([
      songDoc('c1', 'target', { hash: 'hNew', artist: 'Artiste' }),
      songDoc('c2', 'wasTwin', { hash: 'hOld', artist: 'Autre' }),
      songDoc('c3', 'nowTwin', { hash: 'hNew', artist: 'Encore' }),
      songDoc('c4', 'unrelated', { hash: 'hZ', artist: 'Personne' }),
    ]);

    await updateDoublonsAfterReplace(db, 'c1', 'target', {
      oldHash: 'hOld', newHash: 'hNew', artist: 'Artiste',
    });

    expect(db.writes.map((w) => w.path).sort()).toEqual(['c1/target', 'c2/wasTwin', 'c3/nowTwin']);
    // Stale chip is gone: wasTwin no longer points at target.
    expect(written(db, 'c2/wasTwin')).toEqual({ sameTrack: [], sameArtist: [] });
    expect(written(db, 'c3/nowTwin').sameTrack).toEqual([{ compilationId: 'c1', songId: 'target' }]);
  });
});

describe('recomputeDoublonsForCompilation', () => {
  test('one pass links tracks of the same album that a per-song race would miss', async () => {
    // Two tracks of c1 share an artist. Uploaded concurrently, each song's own
    // recompute read a snapshot without the other, so both ended up with nothing.
    const db = fakeDb([
      songDoc('c1', 'a', { hash: 'h1', artist: 'Nina Simone' }),
      songDoc('c1', 'b', { hash: 'h2', artist: 'nina simone' }),
      songDoc('c9', 'far', { hash: 'h3', artist: 'Personne' }),
    ]);

    const updated = await recomputeDoublonsForCompilation(db, 'c1');

    expect(updated).toBe(2);
    expect(written(db, 'c1/a').sameArtist).toEqual([{ compilationId: 'c1', songId: 'b' }]);
    expect(written(db, 'c1/b').sameArtist).toEqual([{ compilationId: 'c1', songId: 'a' }]);
  });

  test('pulls in songs outside the compilation that share a hash', async () => {
    const db = fakeDb([
      songDoc('c1', 'a', { hash: 'h1', artist: null }),
      songDoc('c2', 'elsewhere', { hash: 'h1', artist: null }),
    ]);
    await recomputeDoublonsForCompilation(db, 'c1');
    expect(written(db, 'c2/elsewhere').sameTrack).toEqual([{ compilationId: 'c1', songId: 'a' }]);
  });

  test('an empty compilation is a no-op', async () => {
    const db = fakeDb([songDoc('c2', 'x', { hash: 'h', artist: 'A' })]);
    expect(await recomputeDoublonsForCompilation(db, 'c1')).toBe(0);
    expect(db.writes).toHaveLength(0);
  });
});

describe('recomputeDoublonsForSeeds', () => {
  test('seeding several songs together resolves them against each other', async () => {
    const db = fakeDb([
      songDoc('c1', 'a', { hash: 'h1', artist: 'X' }),
      songDoc('c1', 'b', { hash: 'h1', artist: 'X' }),
    ]);
    const updated = await recomputeDoublonsForSeeds(db, [
      { compilationId: 'c1', songId: 'a', hashes: ['h1'], artist: 'X' },
      { compilationId: 'c1', songId: 'b', hashes: ['h1'], artist: 'X' },
    ]);
    expect(updated).toBe(2);
    expect(written(db, 'c1/a').sameTrack).toEqual([{ compilationId: 'c1', songId: 'b' }]);
  });

  test('a seed whose doc vanished mid-flight does not break the pass', async () => {
    const db = fakeDb([songDoc('c1', 'survivor', { hash: 'h1', artist: 'X' })]);
    await recomputeDoublonsForSeeds(db, [
      { compilationId: 'c1', songId: 'deleted', hashes: ['h9'], artist: 'Y' },
      { compilationId: 'c1', songId: 'survivor', hashes: ['h1'], artist: 'X' },
    ]);
    expect(db.writes.map((w) => w.path)).toEqual(['c1/survivor']);
  });

  test('null hashes are ignored rather than matching each other', async () => {
    const db = fakeDb([
      songDoc('c1', 'a', { hash: null, artist: 'X' }),
      songDoc('c2', 'b', { hash: null, artist: 'Y' }),
    ]);
    await recomputeDoublonsForSeeds(db, [
      { compilationId: 'c1', songId: 'a', hashes: [null], artist: 'X' },
    ]);
    expect(written(db, 'c1/a')).toEqual({ sameTrack: [], sameArtist: [] });
    expect(db.writes.map((w) => w.path)).toEqual(['c1/a']);
  });
});

describe('rebuildAllDoublons', () => {
  test('rewrites every song and reports the count', async () => {
    const db = fakeDb([
      songDoc('c1', 'a', { hash: 'h1', artist: 'X' }),
      songDoc('c2', 'b', { hash: 'h1', artist: 'X' }),
      songDoc('c3', 'c', { hash: 'h2', artist: 'Z' }),
    ]);
    expect(await rebuildAllDoublons(db)).toBe(3);
    expect(db.writes).toHaveLength(3);
    expect(written(db, 'c3/c')).toEqual({ sameTrack: [], sameArtist: [] });
  });
});
