// Community emoji-reaction aggregation across all users.
//
// One collection-group read over every user's /reactions subcollection builds an
// in-memory map of who reacted with what on each song. Loaded lazily (idempotent,
// like ensureSongsLoaded) the first time a song UI needs an aggregate strip.
//
// NB: other users' reactions do NOT live-update within a session — we don't
// attach an onSnapshot listener (this is a friends-scale site). The aggregate
// reflects whatever was loaded at first query plus the current user's own edits,
// which are folded in via applyLocalChange so their own toggles update instantly.

import { db } from './firebase-init.js';
import {
  collectionGroup,
  getDocs,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js';
import { EMOJIS, emojisFromDoc } from './reactions.js';

// songId → Map<emoji, Set<userEmailLower>>
const agg = new Map();
let loadPromise = null;

function bucket(songId) {
  let m = agg.get(songId);
  if (!m) { m = new Map(); agg.set(songId, m); }
  return m;
}

export function ensureCommunityReactionsLoaded() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const snap = await getDocs(collectionGroup(db, 'reactions'));
    snap.forEach((d) => {
      const songId = d.id;
      const userEmail = d.ref.parent.parent?.id; // /users/{email}/reactions/{songId}
      if (!userEmail) return;
      const m = bucket(songId);
      for (const emoji of emojisFromDoc(d.data())) {
        let users = m.get(emoji);
        if (!users) { users = new Set(); m.set(emoji, users); }
        users.add(userEmail);
      }
    });
  })().catch((err) => {
    console.error('load community reactions', err);
    loadPromise = null; // allow a later retry
  });
  return loadPromise;
}

// Palette index for stable ordering. Built lazily: reactions.js and this module
// import each other, so EMOJIS must not be read at module-eval time.
let emojiOrder = null;
function orderOf(emoji) {
  if (!emojiOrder) emojiOrder = new Map(EMOJIS.map((e, i) => [e, i]));
  return emojiOrder.get(emoji) ?? 99;
}

// Aggregate for one song, ordered by palette order. Each entry: { emoji, users }.
export function getAggregate(songId) {
  const m = agg.get(songId);
  if (!m) return [];
  return [...m.entries()]
    .filter(([, users]) => users.size > 0)
    .map(([emoji, users]) => ({ emoji, users: [...users] }))
    .sort((a, b) => orderOf(a.emoji) - orderOf(b.emoji));
}

// Fold a single local toggle into the aggregate so the current user's edits show
// up immediately without re-querying. Called by reactions.js toggleEmoji.
export function applyLocalChange(songId, emoji, userEmail, added) {
  const m = bucket(songId);
  let users = m.get(emoji);
  if (added) {
    if (!users) { users = new Set(); m.set(emoji, users); }
    users.add(userEmail);
  } else if (users) {
    users.delete(userEmail);
    if (users.size === 0) m.delete(emoji);
  }
}
