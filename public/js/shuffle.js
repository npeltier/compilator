// Queue builders for the four cross-compilation play modes.
// All return Track[] in shape expected by player.playQueue().

import {
  allCompilations,
  allSongs,
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
export function queueAllSongs() {
  return shuffle(allSongs().map((s) => trackFromSongId(s.id)).filter(Boolean));
}

// "Sauf les 😬" — every song minus the user's disliked ones.
export function queueAllExceptDisliked() {
  const skip = new Set(dislikedSongIds());
  return shuffle(
    allSongs()
      .filter((s) => !skip.has(s.id))
      .map((s) => trackFromSongId(s.id))
      .filter(Boolean),
  );
}

// "Mes coups de cœur" — only the user's liked songs.
export function queueLikedSongs() {
  return shuffle(likedSongIds().map((id) => trackFromSongId(id)).filter(Boolean));
}

// Per-section "shuffle this season+year". Songs are already attached to their
// compilation in the catalog (songs are a subcollection), so we filter the
// in-memory map without extra round trips.
export function queueSeasonYear(season, year) {
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
