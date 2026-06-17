// Queue builders for the four cross-compilation play modes.
// All return Track[] in shape expected by player.playQueue().

import {
  visibleCompilations,
  visibleSongs,
  ensureSongsLoaded,
  trackFromSongId,
} from './catalog.js';
import { getMyEmojis } from './reactions.js';

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
  return shuffle(visibleSongs().map((s) => trackFromSongId(s.id)).filter(Boolean));
}

// Filter by the user's OWN emoji tags: keep songs the user tagged with at least
// one `want` emoji (no `want` constraint means "any"), and drop any song the user
// tagged with a `dontWant` emoji. Optionally restrict to a set of compilations.
// Powers the home emoji filter's "Lire la sélection".
function matchesMyEmojis(songId, want, dontWant) {
  if (!want?.size && !dontWant?.size) return true;
  const mine = getMyEmojis(songId);
  for (const e of dontWant || []) if (mine.has(e)) return false;
  if (!want?.size) return true;
  for (const e of want) if (mine.has(e)) return true;
  return false;
}

export async function queueByMyEmojis(want, dontWant, compIds = null) {
  await ensureSongsLoaded();
  const set = compIds && !(compIds instanceof Set) ? new Set(compIds) : compIds;
  const songs = set && set.size
    ? visibleSongs().filter((s) => set.has(s.compilationId))
    : visibleSongs();
  return shuffle(
    songs
      .filter((s) => matchesMyEmojis(s.id, want, dontWant))
      .map((s) => trackFromSongId(s.id))
      .filter(Boolean),
  );
}

// Per-section "shuffle this season+year". Songs are already attached to their
// compilation in the catalog (songs are a subcollection), so we filter the
// in-memory map without extra round trips.
export async function queueSeasonYear(season, year) {
  await ensureSongsLoaded();
  const yearNum = typeof year === 'string' ? parseInt(year, 10) : year;
  const compIds = new Set(
    visibleCompilations()
      .filter((c) => c.season === season && c.year === yearNum)
      .map((c) => c.id),
  );
  const tracks = visibleSongs()
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
    visibleSongs()
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
    visibleCompilations().filter((c) => c.author === key).map((c) => c.id),
  );
  const tracks = visibleSongs()
    .filter((s) => compIds.has(s.compilationId))
    .map((s) => trackFromSongId(s.id))
    .filter(Boolean);
  return shuffle(tracks);
}
