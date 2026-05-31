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

const firestoreMock = {
  collection: jest.fn(),
  doc: jest.fn(),
};

const songsCollection = {
  where: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  get: jest.fn(),
  doc: jest.fn(),
};

const compRef = {
  get: jest.fn(),
  set: jest.fn(() => Promise.resolve()),
  collection: jest.fn(() => ({
    doc: jest.fn(() => ({ id: 'track_id', set: jest.fn(() => Promise.resolve()) })),
  })),
};

const compilationsCollection = {
  doc: jest.fn(() => compRef),
};

firestoreMock.collection.mockImplementation((name) => {
  if (name === 'songs') return songsCollection;
  if (name === 'compilations') return compilationsCollection;
  return null;
});

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
};
const bucketMock = {
  file: jest.fn((path) => {
    if (path === 'uploads/u1/abc.mp3') return stagingFileMock;
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

const { processSongFromStaging, replaceTrackSongFromStaging } = await import('../processing.js');

describe('processSongFromStaging', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    songsCollection.doc.mockReturnValue({ id: 'new_song_id', set: jest.fn(() => Promise.resolve()) });
    compRef.get.mockResolvedValue({ exists: true, data: () => ({ coverPath: null }) });
    compRef.collection.mockReturnValue({
      doc: jest.fn(() => ({ id: 'track_id', set: jest.fn(() => Promise.resolve()) })),
    });
  });

  test('dedup miss: stores new song, creates track, returns dedupHit=false', async () => {
    songsCollection.get.mockResolvedValueOnce({ empty: true, docs: [] });
    const result = await processSongFromStaging({
      tempPath: 'uploads/u1/abc.mp3',
      compilationId: 'comp1',
      order: 0,
      uploaderUid: 'u1',
    });
    expect(result.dedupHit).toBe(false);
    expect(result.songId).toBe('new_song_id');
    expect(storeFileMock.save).toHaveBeenCalled();
    expect(stagingFileMock.delete).toHaveBeenCalled();
  });

  test('dedup hit: reuses existing song, does not write to store', async () => {
    songsCollection.get.mockResolvedValueOnce({
      empty: false,
      docs: [{ id: 'existing_id', data: () => ({ hash: 'h', title: 'T', artist: 'A', duration: 200 }) }],
    });
    const result = await processSongFromStaging({
      tempPath: 'uploads/u1/abc.mp3',
      compilationId: 'comp1',
      order: 1,
      uploaderUid: 'u1',
    });
    expect(result.dedupHit).toBe(true);
    expect(result.songId).toBe('existing_id');
    expect(storeFileMock.save).not.toHaveBeenCalled();
  });

  test('throws on missing args', async () => {
    await expect(processSongFromStaging({})).rejects.toThrow();
  });
});

describe('replaceTrackSongFromStaging', () => {
  let trackSetMock;
  let trackRef;
  let tracksColl;
  const oldTrack = { songId: 'old_song', duration: 120, title: 'User Title', artist: 'User Artist', order: 0 };

  beforeEach(() => {
    jest.clearAllMocks();
    songsCollection.doc.mockReturnValue({ id: 'new_song_id', set: jest.fn(() => Promise.resolve()) });
    trackSetMock = jest.fn(() => Promise.resolve());
    trackRef = {
      get: jest.fn(async () => ({ exists: true, data: () => oldTrack })),
      set: trackSetMock,
    };
    tracksColl = { doc: jest.fn(() => trackRef) };
    compRef.collection.mockReturnValue(tracksColl);
    compRef.get.mockResolvedValue({ exists: true, data: () => ({ authorUid: 'u1', coverPath: 'covers/c.jpg' }) });
    adminAdminsGet.mockResolvedValue({ exists: false });
  });

  test('author replaces track: updates songId + duration, preserves overrides, adjusts totalDuration delta', async () => {
    songsCollection.get.mockResolvedValueOnce({ empty: true, docs: [] });
    const result = await replaceTrackSongFromStaging({
      tempPath: 'uploads/u1/abc.mp3',
      compilationId: 'comp1',
      trackId: 'track_id',
      uploaderUid: 'u1',
      callerEmail: 'u1@example.com',
    });
    expect(result.dedupHit).toBe(false);
    expect(result.songId).toBe('new_song_id');
    expect(result.duration).toBe(180);
    // Track update: songId + duration only — no title/artist field touched.
    const trackUpdate = trackSetMock.mock.calls[0][0];
    expect(trackUpdate.songId).toBe('new_song_id');
    expect(trackUpdate.duration).toBe(180);
    expect(trackUpdate.title).toBeUndefined();
    expect(trackUpdate.artist).toBeUndefined();
    // Compilation totalDuration delta = new - old = 180 - 120 = 60.
    const compUpdate = compRef.set.mock.calls.find((c) => c[0].totalDuration)?.[0];
    expect(compUpdate.totalDuration.__increment).toBe(60);
    expect(stagingFileMock.delete).toHaveBeenCalled();
  });

  test('dedup hit: reuses existing song, no /store write', async () => {
    songsCollection.get.mockResolvedValueOnce({
      empty: false,
      docs: [{ id: 'existing_id', data: () => ({ hash: 'h', title: 'T', artist: 'A', duration: 200 }) }],
    });
    const result = await replaceTrackSongFromStaging({
      tempPath: 'uploads/u1/abc.mp3',
      compilationId: 'comp1',
      trackId: 'track_id',
      uploaderUid: 'u1',
      callerEmail: 'u1@example.com',
    });
    expect(result.dedupHit).toBe(true);
    expect(result.songId).toBe('existing_id');
    expect(storeFileMock.save).not.toHaveBeenCalled();
  });

  test('rejects non-author non-admin caller', async () => {
    compRef.get.mockResolvedValue({ exists: true, data: () => ({ authorUid: 'someone-else' }) });
    adminAdminsGet.mockResolvedValue({ exists: false });
    await expect(replaceTrackSongFromStaging({
      tempPath: 'uploads/u1/abc.mp3',
      compilationId: 'comp1',
      trackId: 'track_id',
      uploaderUid: 'u1',
      callerEmail: 'u1@example.com',
    })).rejects.toThrow(/author or an admin/);
  });

  test('admin (non-author) is allowed to replace', async () => {
    compRef.get.mockResolvedValue({ exists: true, data: () => ({ authorUid: 'someone-else' }) });
    adminAdminsGet.mockResolvedValue({ exists: true });
    songsCollection.get.mockResolvedValueOnce({ empty: true, docs: [] });
    const result = await replaceTrackSongFromStaging({
      tempPath: 'uploads/u1/abc.mp3',
      compilationId: 'comp1',
      trackId: 'track_id',
      uploaderUid: 'u1',
      callerEmail: 'admin@example.com',
    });
    expect(result.songId).toBe('new_song_id');
  });

  test('throws on missing args', async () => {
    await expect(replaceTrackSongFromStaging({})).rejects.toThrow();
  });
});
