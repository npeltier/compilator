// Central in-memory cache for the music catalog.
//
// Loaded once on shell boot via `loadCatalog()`:
//   - songsById:           Map<songId, songDoc>
//   - compilationsById:    Map<compId, compDoc>
//   - placementBySongId:   Map<songId, { compilationId, compilationTitle, coverPath, season, year }>
//
// The placement index lets the player show the cover for any song in any
// shuffle queue without an extra round-trip — we pick the first compilation
// the song appears in (sorted by compilation createdAt asc, so the earliest
// historic appearance wins).
//
// Total reads on cold start for ~150 compilations / ~3000 songs: 3 collection
// queries (songs, compilations, collection-group tracks). Roughly 6k docs;
// returns in a few hundred ms.

import { db } from './firebase-init.js';
import {
  collection,
  collectionGroup,
  getDocs,
  orderBy,
  query,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js';

const songsById = new Map();
const compilationsById = new Map();
const placementBySongId = new Map();
const usersByUid = new Map();
const usersByDisplayName = new Map(); // lowercased displayName → user doc
let loaded = false;

export async function loadCatalog() {
  if (loaded) return;

  const [songsSnap, compsSnap, tracksSnap, usersSnap] = await Promise.all([
    getDocs(collection(db, 'songs')),
    getDocs(query(collection(db, 'compilations'), orderBy('createdAt', 'asc'))),
    getDocs(collectionGroup(db, 'tracks')),
    getDocs(collection(db, 'users')),
  ]);

  usersByUid.clear();
  usersByDisplayName.clear();
  usersSnap.forEach((d) => {
    const u = { uid: d.id, ...d.data() };
    usersByUid.set(d.id, u);
    if (u.displayName) usersByDisplayName.set(u.displayName.toLowerCase(), u);
  });

  songsById.clear();
  songsSnap.forEach((d) => songsById.set(d.id, { id: d.id, ...d.data() }));

  compilationsById.clear();
  compsSnap.forEach((d) => compilationsById.set(d.id, { id: d.id, ...d.data() }));

  // Tracks come back unsorted via collectionGroup; walk in compilation-createdAt
  // order so the first placement we record is the earliest historic appearance.
  const tracksByComp = new Map();
  tracksSnap.forEach((d) => {
    const compId = d.ref.parent.parent.id;
    if (!tracksByComp.has(compId)) tracksByComp.set(compId, []);
    tracksByComp.get(compId).push({ ...d.data(), trackId: d.id });
  });

  placementBySongId.clear();
  for (const comp of compilationsById.values()) {
    const tracks = tracksByComp.get(comp.id) || [];
    for (const t of tracks) {
      if (!t.songId || placementBySongId.has(t.songId)) continue;
      placementBySongId.set(t.songId, {
        compilationId: comp.id,
        compilationTitle: comp.title || '',
        coverPath: comp.coverPath || null,
        season: comp.season || null,
        year: comp.year || null,
      });
    }
  }
  loaded = true;
}

export function getSong(id) { return songsById.get(id); }
export function allSongs() { return [...songsById.values()]; }
export function getCompilation(id) { return compilationsById.get(id); }
export function allCompilations() { return [...compilationsById.values()]; }
export function getPlacement(songId) { return placementBySongId.get(songId) || null; }
export function getUser(uid) { return usersByUid.get(uid) || null; }
export function getUserByDisplayName(name) {
  return name ? usersByDisplayName.get(name.toLowerCase()) || null : null;
}

// Mutate a user record after the boot fetch — used after the current user
// updates their own profile (displayName / avatar) so the rest of the SPA
// sees the change without a reload.
export function updateUserLocal(uid, patch) {
  const u = usersByUid.get(uid) || { uid };
  const oldName = u.displayName;
  Object.assign(u, patch);
  usersByUid.set(uid, u);
  if (oldName && oldName !== u.displayName) {
    usersByDisplayName.delete(oldName.toLowerCase());
  }
  if (u.displayName) usersByDisplayName.set(u.displayName.toLowerCase(), u);
}

// Build a Track (the shape used by the player queue) from a songId.
// Returns null if the song isn't in the catalog (defensive — shouldn't happen).
export function trackFromSongId(songId) {
  const s = songsById.get(songId);
  if (!s) return null;
  const p = placementBySongId.get(songId) || {};
  return {
    songId,
    storagePath: s.storagePath,
    title: s.title || 'Sans titre',
    artist: s.artist || '',
    duration: s.duration || 0,
    compilationId: p.compilationId || null,
    compilationTitle: p.compilationTitle || '',
    coverPath: p.coverPath || null,
  };
}
