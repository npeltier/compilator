// Queue builders for the four cross-compilation play modes.
// All return Track[] in shape expected by player.playQueue().

import {
  allCompilations,
  allSongs,
  ensureSongsLoaded,
  trackFromSongId,
} from './catalog.js';
import { dislikedSongIds, likedSongIds } from './reactions.js';

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// "Tout en aléatoire" — every song, including disliked ones.
export async function queueAllSongs() {
  await ensureSongsLoaded();
  return shuffle(allSongs().map((s) => trackFromSongId(s.id)).filter(Boolean));
}

// "Sauf les 😬" — every song minus the user's disliked ones.
export async function queueAllExceptDisliked() {
  await ensureSongsLoaded();
  const skip = new Set(dislikedSongIds());
  return shuffle(
    allSongs()
      .filter((s) => !skip.has(s.id))
      .map((s) => trackFromSongId(s.id))
      .filter(Boolean),
  );
}

// "Mes coups de cœur" — only the user's liked songs.
export async function queueLikedSongs() {
  await ensureSongsLoaded();
  return shuffle(likedSongIds().map((id) => trackFromSongId(id)).filter(Boolean));
}

// Per-section "shuffle this season+year". Songs are already attached to their
// compilation in the catalog (songs are a subcollection), so we filter the
// in-memory map without extra round trips.
export async function queueSeasonYear(season, year) {
  await ensureSongsLoaded();
  const yearNum = typeof year === 'string' ? parseInt(year, 10) : year;
  const compIds = new Set(
    allCompilations()
      .filter((c) => c.season === season && c.year === yearNum)
      .map((c) => c.id),
  );
  const tracks = allSongs()
    .filter((s) => compIds.has(s.compilationId))
    .map((s) => trackFromSongId(s.id))
    .filter(Boolean);
  return shuffle(tracks);
}

// Songs drawn from an explicit set of compilation ids, shuffled. Powers the
// home view's multi-select filter "play selection" button, where the chosen
// authors × seasons resolve to a set of compilations.
export async function queueCompilations(compIds) {
  await ensureSongsLoaded();
  const set = compIds instanceof Set ? compIds : new Set(compIds);
  return shuffle(
    allSongs()
      .filter((s) => set.has(s.compilationId))
      .map((s) => trackFromSongId(s.id))
      .filter(Boolean),
  );
}

// "Tout chez {auteur} en aléatoire" — every song from compilations authored by
// the given email, shuffled.
export async function queueAuthor(authorEmail) {
  await ensureSongsLoaded();
  const key = (authorEmail || '').toLowerCase();
  const compIds = new Set(
    allCompilations().filter((c) => c.author === key).map((c) => c.id),
  );
  const tracks = allSongs()
    .filter((s) => compIds.has(s.compilationId))
    .map((s) => trackFromSongId(s.id))
    .filter(Boolean);
  return shuffle(tracks);
}
