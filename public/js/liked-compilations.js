// Per-user ❤️ likes on whole compilations (distinct from the per-song reactions
// in reactions.js).
//
// Data model: /users/{emailLower}/likedCompilations/{compId} { at }
//
// One read on shell boot (small per-user subcollection); writes happen as the
// user clicks the heart on a compilation. Listeners are notified after each
// change so the compilation page and the profile list re-render in sync.

import { db } from './firebase-init.js';
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  serverTimestamp,
  setDoc,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js';

const cache = new Set();
const listeners = new Set();
let userKey = null;

export async function loadLikedCompilations(email) {
  userKey = (email || '').toLowerCase();
  cache.clear();
  const snap = await getDocs(collection(db, 'users', userKey, 'likedCompilations'));
  snap.forEach((d) => cache.add(d.id));
}

export function isCompLiked(compId) { return cache.has(compId); }
export function likedCompilationIds() { return [...cache]; }
export function likedCompCount() { return cache.size; }

// Set/clear a like. Pass `false` to unlike explicitly.
export async function setCompLike(compId, liked) {
  if (!userKey) throw new Error('liked compilations not loaded');
  const ref = doc(db, 'users', userKey, 'likedCompilations', compId);
  if (!liked) {
    cache.delete(compId);
    emit(compId);
    try { await deleteDoc(ref); } catch (err) { console.error('clear comp like', err); }
    return;
  }
  cache.add(compId);
  emit(compId);
  try {
    await setDoc(ref, { at: serverTimestamp() });
  } catch (err) {
    console.error('save comp like', err);
  }
}

export async function toggleCompLike(compId) {
  await setCompLike(compId, !isCompLiked(compId));
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(compId) {
  for (const fn of listeners) {
    try { fn(compId); } catch (err) { console.error('comp like listener', err); }
  }
}
