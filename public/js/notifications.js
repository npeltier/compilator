// Notifications data layer.
//
// Builds a recency-sorted feed of activity that concerns the current user:
//   - other people's emoji reactions on songs from *their* compilations
//   - new compilations published by other people
// "New" is measured against a per-user last-seen marker persisted in the
// owner-only /users/{email}/private/notifications doc (same shape as the Discogs
// token — see views/profile.js). On the very first load the marker is absent, so
// we initialise it to "now": pre-existing activity is treated as already-seen and
// the badge starts at 0 (no day-one flood).
//
// There is no server-side fan-out and no reverse index; the reaction side reuses
// the single whole-corpus collectionGroup('reactions') scan already performed by
// community-reactions.js (reactionEvents()), so this adds no extra corpus read.

import { db } from './firebase-init.js';
import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js';
import {
  allSongs,
  getCompilation,
  trackFromSongId,
  visibleCompilations,
  ensureSongsLoaded,
} from './catalog.js';
import { ensureCommunityReactionsLoaded, reactionEvents } from './community-reactions.js';

const FEED_CAP = 50;

let myEmail = '';
let lastSeen = 0;          // millis; entries with ts > lastSeen are "unread"
let feed = [];             // merged, recency-sorted notification entries

function privateRef() {
  return doc(db, 'users', myEmail, 'private', 'notifications');
}

// Song ids whose parent compilation is authored by the current user.
function mySongIds() {
  const ids = new Set();
  for (const s of allSongs()) {
    if (getCompilation(s.compilationId)?.author?.toLowerCase() === myEmail) ids.add(s.id);
  }
  return ids;
}

// Load (or initialise) the last-seen marker. Returns millis; 0 only on a
// transient read failure (treated as "everything already seen" to stay quiet).
async function loadLastSeen() {
  try {
    const snap = await getDoc(privateRef());
    const ms = snap.exists() ? snap.data().lastSeenAt?.toMillis?.() : undefined;
    if (ms != null) return ms;
    // First ever load: seed the marker so today's backlog counts as seen.
    await setDoc(privateRef(), { lastSeenAt: serverTimestamp() }, { merge: true });
    return Date.now();
  } catch (err) {
    console.warn('notifications: lastSeen read failed', err);
    return Date.now();
  }
}

// Build the merged feed. Cheap (in-memory) once songs + reactions are loaded.
export async function loadNotifications(email) {
  myEmail = (email || '').toLowerCase();
  if (!myEmail) return [];

  const [seen] = await Promise.all([
    loadLastSeen(),
    ensureSongsLoaded(),
    ensureCommunityReactionsLoaded(),
  ]);
  lastSeen = seen;

  const mine = mySongIds();
  const entries = [];

  for (const ev of reactionEvents()) {
    if (ev.user.toLowerCase() === myEmail) continue;  // not my own reactions
    if (!mine.has(ev.songId)) continue;               // only on my tracks
    const track = trackFromSongId(ev.songId);
    if (!track) continue;                             // orphaned song
    entries.push({ type: 'reaction', ts: ev.at, reactor: ev.user, emojis: ev.emojis, track });
  }

  for (const c of visibleCompilations()) {
    if ((c.author || '').toLowerCase() === myEmail) continue;  // not my own comps
    entries.push({ type: 'comp', ts: c.createdAt?.toMillis?.() || 0, comp: c });
  }

  entries.sort((a, b) => b.ts - a.ts);
  feed = entries.slice(0, FEED_CAP);
  return feed;
}

export function getFeed() { return feed; }

// The live unread cut in millis: entries with ts greater than this are unread.
// Callers grab this to decide row highlighting *before* calling markSeen (which
// advances it), so the just-opened panel still shows what was new.
export function currentCut() { return lastSeen; }

export function unreadCount() {
  return feed.reduce((n, e) => n + (e.ts > lastSeen ? 1 : 0), 0);
}

// Dev/admin only: prepend fake unread entries to the feed so the badge, toast
// and panel can be exercised without a second user or the emulator. Purely
// in-memory — nothing is written to Firestore. Used by the /notif-test page.
export function injectSampleNotifications(count = 3) {
  const base = Date.now() + 60_000; // safely above the current seen-cut → unread
  const emojis = ['❤️', '🔥', '😂', '🎧', '👏'];
  const names = ['alice', 'bruno', 'chloé', 'david', 'élodie'];
  const added = [];
  for (let i = 0; i < count; i++) {
    added.push({
      type: 'reaction',
      ts: base + i * 1000,
      reactor: `${names[i % names.length]}@example.com`,
      emojis: [emojis[i % emojis.length]],
      track: { title: `Morceau de test ${i + 1}`, compilationId: null, compilationTitle: '' },
    });
  }
  added.push({
    type: 'comp',
    ts: base + count * 1000,
    comp: { id: 'test-comp', title: 'Compilation de test', author: 'zoé@example.com' },
  });
  feed = [...added, ...feed];
  return added.length;
}

// Mark everything up to now as seen: advance the in-memory cut (so unreadCount
// drops to 0 and a later reopen shows the rows as read) and persist the marker.
export async function markSeen() {
  lastSeen = Date.now();
  try {
    await setDoc(privateRef(), { lastSeenAt: serverTimestamp() }, { merge: true });
  } catch (err) {
    console.warn('notifications: markSeen failed', err);
  }
}
