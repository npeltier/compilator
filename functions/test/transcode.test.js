// Real-ffmpeg regression test for the audio ingest path.
//
// Everything else in processing.test.js mocks fluent-ffmpeg, which is what let
// this bug through: a real M4A keeps its `moov` atom at the *end* of the file, so
// ffmpeg only learns where the samples live after reading the whole stream and
// has to seek back to reach them. Fed a non-seekable pipe it can't — it logs
// "partial file", encodes zero frames, and still exits 0, so the 'error' handler
// never fires and a ~1KB silent MP3 sails through hashing and into /store/.
//
// Only storage + firestore are mocked here; ffmpeg and music-metadata are real.

import { jest } from '@jest/globals';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, unlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { parseBuffer } from 'music-metadata';

const run = promisify(execFile);

jest.unstable_mockModule('firebase-admin', () => ({
  default: { apps: [{}], initializeApp: jest.fn(), firestore: jest.fn() },
}));

const songSetMock = jest.fn(async () => {});
const compRef = {
  get: jest.fn(async () => ({ exists: true, data: () => ({ coverPath: 'covers/c.jpg' }) })),
  set: jest.fn(async () => {}),
  collection: jest.fn(() => ({ doc: () => ({ id: 'song_id', set: songSetMock }) })),
};
jest.unstable_mockModule('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => ({
    collection: jest.fn(() => ({ doc: jest.fn(() => compRef) })),
    collectionGroup: jest.fn(() => ({ get: async () => ({ forEach: () => {} }) })),
    bulkWriter: jest.fn(() => ({ set: jest.fn(), close: async () => {} })),
  })),
  FieldValue: { serverTimestamp: () => 'TS', increment: (n) => ({ __increment: n }) },
}));

// The staging blob's bytes are swapped per test; whatever lands in /store/ is
// captured so we can assert on the actual audio that would have been served.
let stagingBytes = Buffer.alloc(0);
const stored = [];
const stagingFile = {
  download: jest.fn(async () => [stagingBytes]),
  delete: jest.fn(async () => {}),
};
const storeFile = {
  exists: jest.fn(async () => [false]),
  save: jest.fn(async (buf) => { stored.push(buf); }),
};
jest.unstable_mockModule('firebase-admin/storage', () => ({
  getStorage: jest.fn(() => ({
    bucket: () => ({ file: (p) => (p.startsWith('uploads/') ? stagingFile : storeFile) }),
  })),
}));

const { processSongFromStaging } = await import('../processing.js');

const FF = ffmpegInstaller.path;
const tmp = (ext) => join(tmpdir(), `fixture-${randomUUID()}.${ext}`);

// A 3s AAC/M4A. ffmpeg writes `moov` last unless asked for +faststart, which is
// exactly the layout that broke — assert that rather than trusting the default.
async function makeM4a() {
  const path = tmp('m4a');
  await run(FF, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:a', 'aac', '-b:a', '128k', path]);
  const buf = await readFile(path);
  await unlink(path).catch(() => {});
  const moov = buf.indexOf('moov');
  const mdat = buf.indexOf('mdat');
  expect(moov).toBeGreaterThan(mdat);   // index at the end → input must be seekable
  return buf;
}

async function makeMp3() {
  const path = tmp('mp3');
  await run(FF, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:a', 'libmp3lame', path]);
  const buf = await readFile(path);
  await unlink(path).catch(() => {});
  return buf;
}

describe('audio ingest with real ffmpeg', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    stored.length = 0;
    storeFile.exists.mockResolvedValue([false]);
    compRef.get.mockResolvedValue({ exists: true, data: () => ({ coverPath: 'covers/c.jpg' }) });
  });

  test('an M4A with moov-at-end transcodes to real audio, not a silent stub', async () => {
    stagingBytes = await makeM4a();

    const result = await processSongFromStaging({
      tempPath: 'uploads/u1/05.m4a',
      compilationId: 'comp1',
      order: 0,
    });

    // The regression: duration came back 0/null and a ~1KB stub was stored.
    expect(result.duration).toBeGreaterThan(2.5);
    expect(stored).toHaveLength(1);
    expect(stored[0].length).toBeGreaterThan(10_000);

    // What we'd actually serve has to decode as playable MPEG audio.
    const meta = await parseBuffer(stored[0], 'audio/mpeg');
    expect(meta.format.container).toBe('MPEG');
    expect(meta.format.duration).toBeGreaterThan(2.5);
  }, 60_000);

  test('an MP3 passes through untouched (no needless re-encode)', async () => {
    stagingBytes = await makeMp3();

    const result = await processSongFromStaging({
      tempPath: 'uploads/u1/ok.mp3',
      compilationId: 'comp1',
      order: 0,
    });

    expect(result.duration).toBeGreaterThan(2.5);
    expect(stored[0].equals(stagingBytes)).toBe(true);
  }, 60_000);

  test('a file with no audio track is rejected, not stored', async () => {
    // A valid MP4 whose only stream is video: there is nothing to turn into an
    // MP3. Here ffmpeg does exit non-zero ("does not contain any stream"), so the
    // 'error' handler catches it — the duration guard in transcodeToMp3 covers the
    // nastier variant where ffmpeg gives up on the input yet still exits 0.
    const path = tmp('mp4');
    await run(FF, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=1',
      '-c:v', 'mpeg4', '-an', path]);
    stagingBytes = await readFile(path);
    await unlink(path).catch(() => {});

    await expect(processSongFromStaging({
      tempPath: 'uploads/u1/videoonly.mp4',
      compilationId: 'comp1',
      order: 0,
    })).rejects.toThrow();

    // The point: the failure is loud. Nothing reached /store/, no song doc exists.
    expect(stored).toHaveLength(0);
    expect(songSetMock).not.toHaveBeenCalled();
  }, 60_000);
});
