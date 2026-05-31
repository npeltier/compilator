// Queue builders for the four cross-compilation play modes.
// All return Track[] in shape expected by player.playQueue().

import { db } from './firebase-init.js';
import {
  collection,
  getDocs,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js';
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

// "Sauf les 💩" — every song minus the user's disliked ones.
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

// Per-section "shuffle this season+year". Fetches the tracks subcollection of
// each matching compilation so dedup'd songs are correctly attributed to this
// season's tracklist (not just the song's earliest historical placement).
export async function queueSeasonYear(season, year) {
  const yearNum = typeof year === 'string' ? parseInt(year, 10) : year;
  const matches = allCompilations().filter((c) => c.season === season && c.year === yearNum);
  const tracklists = await Promise.all(
    matches.map((c) => getDocs(collection(db, 'compilations', c.id, 'tracks'))),
  );
  const tracks = [];
  const seen = new Set();
  tracklists.forEach((snap, i) => {
    const comp = matches[i];
    snap.forEach((d) => {
      const td = d.data();
      if (!td.songId || seen.has(td.songId)) return;
      seen.add(td.songId);
      const t = trackFromSongId(td.songId);
      if (!t) return;
      // Override compilation context to the season+year compilation, not the
      // first historic placement — so the player cover matches the shuffled set.
      tracks.push({
        ...t,
        compilationId: comp.id,
        compilationTitle: comp.title || '',
        coverPath: comp.coverPath || null,
      });
    });
  });
  return shuffle(tracks);
}
