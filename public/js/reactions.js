// Per-user emoji reactions on songs.
//
// Data model: /users/{emailLower}/reactions/{songId} { emojis: string[], at }
//
// A user can apply several emojis to a single song (a set, not mutually
// exclusive). One read on shell boot (small per-user subcollection); writes
// happen as the user toggles emojis in the picker. Listeners are notified after
// each change so the player and any open track list re-render in sync.
//
// Legacy docs shaped { value: 'like'|'dislike' } are read transparently and
// normalized (like → ❤️, dislike → 👎), so no data migration is needed.

import { db } from './firebase-init.js';
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  serverTimestamp,
  setDoc,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js';
import { applyLocalChange } from './community-reactions.js';

// Curated palette of widely cross-platform-supported emojis. Rendering is
// identical on desktop, iOS and Android. Display order matches this array.
export const EMOJIS = [
  '❤️', '😍', '😂', '🔥', '🎉', '👍', '👎', '😬',
  '🥹', '😭', '🤯', '🕺', '💃', '🎸', '🥁', '🎷',
  '🤘', '✨', '🫶', '🙌', '🍺', '🍸', '🥱', '❄️',
];

// Normalize a reaction doc to an emoji array, tolerating the legacy shape.
export function emojisFromDoc(data) {
  if (Array.isArray(data?.emojis)) return data.emojis;
  if (data?.value === 'like') return ['❤️'];
  if (data?.value === 'dislike') return ['👎'];
  return [];
}

const cache = new Map(); // songId → Set<emoji> (current user's own)
const listeners = new Set();
let userKey = null;

export async function loadReactions(email) {
  userKey = (email || '').toLowerCase();
  cache.clear();
  const snap = await getDocs(collection(db, 'users', userKey, 'reactions'));
  snap.forEach((d) => {
    const emojis = emojisFromDoc(d.data());
    if (emojis.length) cache.set(d.id, new Set(emojis));
  });
}

export function getMyEmojis(songId) {
  return new Set(cache.get(songId) || []);
}
export function hasMyEmoji(songId, emoji) {
  return cache.get(songId)?.has(emoji) || false;
}
export function myEmojiSongIds() {
  return [...cache.keys()];
}
export function songIdsWithMyEmoji(emoji) {
  return [...cache.entries()].filter(([, set]) => set.has(emoji)).map(([id]) => id);
}

// Toggle one emoji for a song: add it if absent, remove it if present. The doc
// is deleted once the user has no emojis left on the song.
export async function toggleEmoji(songId, emoji) {
  if (!userKey) throw new Error('reactions not loaded');
  const set = new Set(cache.get(songId) || []);
  const added = !set.has(emoji);
  if (added) set.add(emoji);
  else set.delete(emoji);

  if (set.size) cache.set(songId, set);
  else cache.delete(songId);

  applyLocalChange(songId, emoji, userKey, added);
  emit(songId);

  const ref = doc(db, 'users', userKey, 'reactions', songId);
  try {
    if (set.size) await setDoc(ref, { emojis: [...set], at: serverTimestamp() });
    else await deleteDoc(ref);
  } catch (err) {
    console.error('save reaction', err);
  }
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
