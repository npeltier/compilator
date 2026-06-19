import { jest } from '@jest/globals';

// Mock firebase-admin: `admin.firestore` is both callable (returns a client with
// .doc(...)) and a namespace (has FieldValue static). The callable form is used
// by auth.js to look up /admins/{email}; the namespace form is unused by
// processing.js (it imports FieldValue from firebase-admin/firestore instead).
const adminAdminsGet = jest.fn(async () => ({ exists: false }));
const adminFirestoreFn = jest.fn(() => ({
  doc: jest.fn(() => ({ get: adminAdminsGet })),
}));
adminFirestoreFn.FieldValue = {
  serverTimestamp: jest.fn(() => 'TS'),
  increment: jest.fn((n) => ({ __increment: n })),
};
jest.unstable_mockModule('firebase-admin', () => ({
  default: {
    apps: [{}],
    initializeApp: jest.fn(),
    firestore: adminFirestoreFn,
  },
}));

const songSetMock = jest.fn(() => Promise.resolve());
const songsSubColl = {
  doc: jest.fn(() => ({ id: 'song_id', set: songSetMock })),
};

const compRef = {
  get: jest.fn(),
  set: jest.fn(() => Promise.resolve()),
  delete: jest.fn(() => Promise.resolve()),
  collection: jest.fn(() => songsSubColl),
};

const compilationsCollection = {
  doc: jest.fn(() => compRef),
};

// Snapshot shape used by both the orphan check (.empty) and findAndUpdateDoublons
// (.forEach). Default to an empty, iterable snapshot so the doublon recompute
// triggered inside processSongFromStaging is a clean no-op rather than throwing.
const collectionGroupGet = jest.fn(async () => ({ empty: true, forEach: () => {} }));
const collectionGroupMock = jest.fn(() => ({
  where: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  get: collectionGroupGet,
}));

const bulkWriterMock = { delete: jest.fn(), set: jest.fn(), close: jest.fn(() => Promise.resolve()) };

const firestoreMock = {
  collection: jest.fn((name) => {
    if (name === 'compilations') return compilationsCollection;
    return null;
  }),
  doc: jest.fn(),
  collectionGroup: collectionGroupMock,
  bulkWriter: jest.fn(() => bulkWriterMock),
};

jest.unstable_mockModule('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => firestoreMock),
  FieldValue: {
    serverTimestamp: jest.fn(() => 'TS'),
    increment: jest.fn((n) => ({ __increment: n })),
  },
}));

const stagingFileMock = {
  download: jest.fn(() => Promise.resolve([Buffer.from('mp3 content')])),
  delete: jest.fn(() => Promise.resolve()),
};
const storeFileMock = {
  save: jest.fn(() => Promise.resolve()),
  exists: jest.fn(() => Promise.resolve([false])),
  delete: jest.fn(() => Promise.resolve()),
  download: jest.fn(() => Promise.resolve([Buffer.from('mp3 content')])),
};
const coverFileMock = {
  save: jest.fn(() => Promise.resolve()),
  delete: jest.fn(() => Promise.resolve()),
};
const bucketMock = {
  file: jest.fn((path) => {
    if (path === 'uploads/u1/abc.mp3') return stagingFileMock;
    if (path?.startsWith('covers/')) return coverFileMock;
    return storeFileMock;
  }),
};
jest.unstable_mockModule('firebase-admin/storage', () => ({
  getStorage: jest.fn(() => ({ bucket: () => bucketMock })),
}));

jest.unstable_mockModule('../hash.js', () => ({
  computeMp3Hash: jest.fn(async () => 'abcdef0000000000000000000000000000000000000000000000000000000000'),
  getStorePath: jest.fn((h) => `store/${h.slice(0, 2)}/${h}.mp3`),
}));

jest.unstable_mockModule('music-metadata', () => ({
  parseBuffer: jest.fn(async () => ({
    format: { duration: 180 },
    common: { title: 'Title', artist: 'Artist', album: 'Album', year: 2024, track: { no: 1 } },
  })),
}));

const {
  processSongFromStaging,
  replaceSongFromStaging,
  deleteCompilationFully,
  recomputeDurationsFromStore,
} = await import('../processing.js');

describe('processSongFromStaging', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    songsSubColl.doc.mockReturnValue({ id: 'song_id', set: songSetMock });
    compRef.collection.mockReturnValue(songsSubColl);
    compRef.get.mockResolvedValue({ exists: true, data: () => ({ coverPath: null }) });
    storeFileMock.exists.mockResolvedValue([false]);
  });

  test('dedup miss (new binary): uploads to /store/, creates song doc with album=compId', async () => {
    const result = await processSongFromStaging({
      tempPath: 'uploads/u1/abc.mp3',
      compilationId: 'comp1',
      order: 0,
    });
    expect(result.dedupHit).toBe(false);
    expect(result.songId).toBe('song_id');
    expect(storeFileMock.save).toHaveBeenCalled();
    // Song was written with album = compilationId
    const songWrite = songSetMock.mock.calls[0][0];
    expect(songWrite.album).toBe('comp1');
    expect(songWrite.hash).toMatch(/^abcdef/);
    expect(songWrite.order).toBe(0);
    expect(stagingFileMock.delete).toHaveBeenCalled();
  });

  test('dedup hit (binary already in /store/): does not re-upload', async () => {
    storeFileMock.exists.mockResolvedValue([true]);
    const result = await processSongFromStaging({
      tempPath: 'uploads/u1/abc.mp3',
      compilationId: 'comp1',
      order: 1,
    });
    expect(result.dedupHit).toBe(true);
    expect(storeFileMock.save).not.toHaveBeenCalled();
    // A new song doc is still created for this compilation, even on dedup hit.
    expect(songSetMock).toHaveBeenCalled();
  });

  test('throws on missing args', async () => {
    await expect(processSongFromStaging({})).rejects.toThrow();
  });
});

describe('replaceSongFromStaging', () => {
  let songSet;
  let songRef;
  let songsSubCollLocal;

  beforeEach(() => {
    jest.clearAllMocks();
    songSet = jest.fn(() => Promise.resolve());
    songRef = {
      get: jest.fn(async () => ({ exists: true, data: () => ({ duration: 120, hash: 'oldhash' }) })),
      set: songSet,
    };
    songsSubCollLocal = { doc: jest.fn(() => songRef) };
    compRef.collection.mockReturnValue(songsSubCollLocal);
    compRef.get.mockResolvedValue({ exists: true, data: () => ({ author: 'u1@example.com', coverPath: 'covers/c.jpg' }) });
    adminAdminsGet.mockResolvedValue({ exists: false });
    storeFileMock.exists.mockResolvedValue([false]);
  });

  test('author replaces song: updates hash/storagePath/duration, adjusts totalDuration delta', async () => {
    const result = await replaceSongFromStaging({
      tempPath: 'uploads/u1/abc.mp3',
      compilationId: 'comp1',
      songId: 'song_id',
      callerEmail: 'u1@example.com',
    });
    expect(result.dedupHit).toBe(false);
    expect(result.duration).toBe(180);
    const songUpdate = songSet.mock.calls[0][0];
    expect(songUpdate.hash).toMatch(/^abcdef/);
    expect(songUpdate.storagePath).toMatch(/^store\//);
    expect(songUpdate.duration).toBe(180);
    // Title/artist/order not touched on replace.
    expect(songUpdate.title).toBeUndefined();
    expect(songUpdate.artist).toBeUndefined();
    expect(songUpdate.order).toBeUndefined();
    // Compilation totalDuration delta = new - old = 180 - 120 = 60.
    const compUpdate = compRef.set.mock.calls.find((c) => c[0].totalDuration)?.[0];
    expect(compUpdate.totalDuration.__increment).toBe(60);
    expect(stagingFileMock.delete).toHaveBeenCalled();
  });

  test('rejects non-author non-admin caller', async () => {
    compRef.get.mockResolvedValue({ exists: true, data: () => ({ author: 'someone@example.com' }) });
    adminAdminsGet.mockResolvedValue({ exists: false });
    await expect(replaceSongFromStaging({
      tempPath: 'uploads/u1/abc.mp3',
      compilationId: 'comp1',
      songId: 'song_id',
      callerEmail: 'u1@example.com',
    })).rejects.toThrow(/author or an admin/);
  });

  test('admin (non-author) is allowed to replace', async () => {
    compRef.get.mockResolvedValue({ exists: true, data: () => ({ author: 'someone@example.com' }) });
    adminAdminsGet.mockResolvedValue({ exists: true });
    const result = await replaceSongFromStaging({
      tempPath: 'uploads/u1/abc.mp3',
      compilationId: 'comp1',
      songId: 'song_id',
      callerEmail: 'admin@example.com',
    });
    expect(result.duration).toBe(180);
  });

  test('throws on missing args', async () => {
    await expect(replaceSongFromStaging({})).rejects.toThrow();
  });
});

describe('deleteCompilationFully', () => {
  let songRefs;

  beforeEach(() => {
    jest.clearAllMocks();
    songRefs = [
      { ref: { id: 's1' }, data: () => ({ hash: 'h1' }) },
      { ref: { id: 's2' }, data: () => ({ hash: 'h2' }) },
    ];
    const songsGet = jest.fn(async () => ({
      empty: false,
      size: songRefs.length,
      forEach: (cb) => songRefs.forEach(cb),
    }));
    compRef.collection.mockReturnValue({ get: songsGet });
    compRef.get.mockResolvedValue({
      exists: true,
      data: () => ({ author: 'u1@example.com', coverPath: 'covers/c.jpg' }),
    });
    adminAdminsGet.mockResolvedValue({ exists: false });
  });

  test('author deletes: removes songs, cover, doc, and orphan binaries', async () => {
    collectionGroupGet.mockResolvedValue({ empty: true });
    const result = await deleteCompilationFully({
      compilationId: 'comp1',
      callerEmail: 'u1@example.com',
    });
    expect(bulkWriterMock.delete).toHaveBeenCalledTimes(2);
    expect(bulkWriterMock.close).toHaveBeenCalled();
    expect(coverFileMock.delete).toHaveBeenCalled();
    expect(compRef.delete).toHaveBeenCalled();
    // Both hashes were orphaned (collectionGroup returned empty), so both binaries deleted.
    expect(storeFileMock.delete).toHaveBeenCalledTimes(2);
    expect(result.songsDeleted).toBe(2);
    expect(result.orphansDeleted).toBe(2);
  });

  test('shared binary is preserved when still referenced elsewhere', async () => {
    collectionGroupGet.mockResolvedValue({ empty: false });
    const result = await deleteCompilationFully({
      compilationId: 'comp1',
      callerEmail: 'u1@example.com',
    });
    expect(storeFileMock.delete).not.toHaveBeenCalled();
    expect(result.orphansDeleted).toBe(0);
  });

  test('rejects non-author non-admin', async () => {
    compRef.get.mockResolvedValue({ exists: true, data: () => ({ author: 'other@example.com' }) });
    adminAdminsGet.mockResolvedValue({ exists: false });
    await expect(deleteCompilationFully({
      compilationId: 'comp1',
      callerEmail: 'u1@example.com',
    })).rejects.toThrow(/author or an admin/);
  });

  test('admin (non-author) is allowed', async () => {
    compRef.get.mockResolvedValue({ exists: true, data: () => ({ author: 'other@example.com' }) });
    adminAdminsGet.mockResolvedValue({ exists: true });
    collectionGroupGet.mockResolvedValue({ empty: true });
    const result = await deleteCompilationFully({
      compilationId: 'comp1',
      callerEmail: 'admin@example.com',
    });
    expect(compRef.delete).toHaveBeenCalled();
    expect(result.songsDeleted).toBe(2);
  });

  test('throws on missing args', async () => {
    await expect(deleteCompilationFully({})).rejects.toThrow();
  });
});

describe('recomputeDurationsFromStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('re-probes only unverified songs, fixes bad durations, refreshes total', async () => {
    // parseBuffer mock (module-level) returns duration 180 for any binary.
    const songDocs = [
      // Bad duration, never verified → should be re-probed and corrected to 180.
      { id: 's1', ref: { id: 's1' }, data: () => ({ duration: 3319, storagePath: 'store/ab/h1.mp3' }) },
      // Already verified → skipped, its 180 is carried into the total untouched.
      { id: 's2', ref: { id: 's2' }, data: () => ({ duration: 180, durationVerified: true, storagePath: 'store/cd/h2.mp3' }) },
    ];
    compRef.collection.mockReturnValue({ get: jest.fn(async () => ({ size: 2, docs: songDocs })) });

    const res = await recomputeDurationsFromStore({ compilationId: 'comp1' });

    expect(res.checked).toBe(1);                 // only the unverified song re-probed
    expect(res.fixed).toBe(1);                   // 3319 → 180 counts as a fix
    expect(res.totalDuration).toBe(360);         // 180 (fixed) + 180 (skipped)
    expect(res.durations).toEqual({ s1: 180, s2: 180 });

    // The fixed song is written with the verified flag; the verified one is not touched.
    expect(bulkWriterMock.set).toHaveBeenCalledTimes(1);
    const [ref, patch] = bulkWriterMock.set.mock.calls[0];
    expect(ref.id).toBe('s1');
    expect(patch.duration).toBe(180);
    expect(patch.durationVerified).toBe(true);
    expect(storeFileMock.download).toHaveBeenCalledTimes(1);

    // Corrected total is persisted on the compilation.
    expect(compRef.set).toHaveBeenCalledWith(
      expect.objectContaining({ totalDuration: 360 }),
      { merge: true },
    );
  });

  test('throws on missing compilationId', async () => {
    await expect(recomputeDurationsFromStore({})).rejects.toThrow();
  });
});
