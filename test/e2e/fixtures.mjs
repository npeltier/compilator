// Generates throwaway MP3 + PNG fixtures for the e2e test.
// - 3 tiny MP3s with distinct ID3 tags (title, artist, track #)
// - 1 tiny PNG cover
// All files land in test/fixtures/ and are git-ignored.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, '..', 'fixtures');

export function fixturesDir() { return FIX; }

function ffmpegBin() {
  // ffmpeg should be on PATH on dev machines; if not, the test should fail loudly.
  return 'ffmpeg';
}

/**
 * Synthesize a small MP3 with ID3 tags. Each file is ~1 s of silence,
 * mono, 32 kbps — adds up to a few kilobytes each.
 */
export function buildMp3({ index, title, artist, album, year, durationSec = 1 }) {
  mkdirSync(FIX, { recursive: true });
  const path = join(FIX, `track-${String(index).padStart(2, '0')}.mp3`);
  if (existsSync(path)) return path;
  const args = [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', `anullsrc=r=44100:cl=mono`,
    '-t', String(durationSec),
    '-c:a', 'libmp3lame',
    '-b:a', '32k',
    '-write_id3v2', '1',
    '-metadata', `title=${title}`,
    '-metadata', `artist=${artist}`,
    '-metadata', `album=${album}`,
    '-metadata', `date=${year}`,
    '-metadata', `track=${index}`,
    path,
  ];
  execFileSync(ffmpegBin(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
  return path;
}

/**
 * Write a small valid PNG (64x64 magenta square) as the cover.
 */
export function buildCover() {
  mkdirSync(FIX, { recursive: true });
  const path = join(FIX, 'cover.png');
  if (existsSync(path)) return path;
  // Use ffmpeg to render a solid color image — simplest cross-platform path.
  execFileSync(ffmpegBin(), [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', 'color=c=#e6562e:s=128x128:d=1',
    '-frames:v', '1',
    path,
  ]);
  return path;
}

/** Build a 3-track album + cover. Returns paths. */
export function buildAlbum() {
  const tracks = [
    { index: 1, title: 'Premier morceau', artist: 'Nicolas P.', album: 'Smoke Test', year: 2026 },
    { index: 2, title: 'Deuxième morceau', artist: 'Nicolas P.', album: 'Smoke Test', year: 2026 },
    { index: 3, title: 'Troisième morceau', artist: 'Nicolas P.', album: 'Smoke Test', year: 2026 },
  ].map((t) => ({ ...t, path: buildMp3(t) }));
  const cover = buildCover();
  return { tracks, cover };
}
