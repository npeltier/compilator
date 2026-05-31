// Per-user song reactions (❤️ like / 💩 dislike).
//
// Data model: /users/{uid}/reactions/{songId} { value: 'like'|'dislike', at }
//
// One read on shell boot (small per-user subcollection); writes happen as the
// user clicks the heart/poop buttons. Listeners are notified after each change
// so the player and any open track list can re-render their icons in sync.

import { db } from './firebase-init.js';
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  serverTimestamp,
  setDoc,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js';

const cache = new Map();
const listeners = new Set();
let userId = null;

export async function loadReactions(uid) {
  userId = uid;
  cache.clear();
  const snap = await getDocs(collection(db, 'users', uid, 'reactions'));
  snap.forEach((d) => cache.set(d.id, d.data().value));
}

export function getReaction(songId) { return cache.get(songId) || null; }
export function isLiked(songId) { return cache.get(songId) === 'like'; }
export function isDisliked(songId) { return cache.get(songId) === 'dislike'; }

export function likedSongIds() {
  return [...cache.entries()].filter(([, v]) => v === 'like').map(([id]) => id);
}
export function dislikedSongIds() {
  return [...cache.entries()].filter(([, v]) => v === 'dislike').map(([id]) => id);
}
export function likeCount() { return likedSongIds().length; }
export function dislikeCount() { return dislikedSongIds().length; }

// Toggle: clicking the same value clears, otherwise sets it. Mutually exclusive
// between like and dislike. Pass `null` to clear explicitly.
export async function setReaction(songId, value) {
  if (!userId) throw new Error('reactions not loaded');
  const ref = doc(db, 'users', userId, 'reactions', songId);
  if (value == null) {
    cache.delete(songId);
    emit(songId);
    try { await deleteDoc(ref); } catch (err) { console.error('clear reaction', err); }
    return;
  }
  cache.set(songId, value);
  emit(songId);
  try {
    await setDoc(ref, { value, at: serverTimestamp() });
  } catch (err) {
    console.error('save reaction', err);
  }
}

export async function toggleLike(songId) {
  await setReaction(songId, isLiked(songId) ? null : 'like');
}
export async function toggleDislike(songId) {
  await setReaction(songId, isDisliked(songId) ? null : 'dislike');
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(songId) {
  for (const fn of listeners) {
    try { fn(songId); } catch (err) { console.error('reaction listener', err); }
  }
}
