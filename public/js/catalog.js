// Central in-memory cache for the music catalog.
//
// Loaded once on shell boot via `loadCatalog()`:
//   - songsById:           Map<songId, songDoc & { compilationId }>
//   - compilationsById:    Map<compId, compDoc>
//   - usersByEmail:        Map<emailLower, userDoc & { email }>
//
// Songs live as a subcollection under each compilation (one song doc per
// occurrence; the binary itself is deduped at the storage layer). The
// collection-group query pulls every song with one round trip; doc.ref.parent
// .parent.id gives us the owning compilation.

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
const usersByEmail = new Map();
const allowlistByEmail = new Map();   // admin-only
let loaded = false;

export async function loadCatalog() {
  if (loaded) return;

  const [compsSnap, songsSnap, usersSnap] = await Promise.all([
    getDocs(query(collection(db, 'compilations'), orderBy('createdAt', 'asc'))),
    getDocs(collectionGroup(db, 'songs')),
    getDocs(collection(db, 'users')),
  ]);

  usersByEmail.clear();
  usersSnap.forEach((d) => {
    usersByEmail.set(d.id.toLowerCase(), { email: d.id, ...d.data() });
  });

  compilationsById.clear();
  compsSnap.forEach((d) => compilationsById.set(d.id, { id: d.id, ...d.data() }));

  songsById.clear();
  songsSnap.forEach((d) => {
    // Skip legacy top-level /songs docs (pre-wipe leftovers) — they have no
    // parent compilation. Once the wipe is done, every song is a subcollection
    // doc and parent.parent always resolves.
    const parentComp = d.ref.parent.parent;
    if (!parentComp) return;
    songsById.set(d.id, { id: d.id, compilationId: parentComp.id, ...d.data() });
  });

  loaded = true;
}

export function getSong(id) { return songsById.get(id); }
export function allSongs() { return [...songsById.values()]; }
export function getCompilation(id) { return compilationsById.get(id); }
export function allCompilations() { return [...compilationsById.values()]; }
export function getUser(email) {
  return email ? usersByEmail.get(email.toLowerCase()) || null : null;
}
export function allUsers() {
  return [...usersByEmail.values()].sort((a, b) =>
    (a.displayName || a.email || '').localeCompare(b.displayName || b.email || '', 'fr'),
  );
}

// Display name for an author email — falls back to the local-part of the email
// if no /users doc exists yet (allowlisted but never signed in).
export function displayNameFor(email) {
  if (!email) return '';
  const u = usersByEmail.get(email.toLowerCase());
  if (u?.displayName) return u.displayName;
  return email.split('@')[0];
}

// Build the URL slug used in /author/:slug links. Prefer a slugified version
// of the author's displayName so the URL is human-readable; fall back to an
// 8-char FNV-1a hash of the email when no displayName exists yet (avoids ever
// surfacing raw emails in URLs).
//
// NB: a displayName change rewrites the slug — old bookmarks break. Accepted
// tradeoff vs leaking emails.
export function authorSlug(email) {
  if (!email) return '';
  const u = usersByEmail.get(email.toLowerCase());
  const slug = slugify(u?.displayName || '');
  return slug || fnv1aHex(email.toLowerCase());
}

// Reverse lookup: given a /author/:slug param, find the matching author email
// by scanning the distinct authors of the currently loaded compilations.
// Returns null if no compilation's author matches.
export function emailFromAuthorSlug(slug) {
  if (!slug) return null;
  const wanted = String(slug).toLowerCase();
  const seen = new Set();
  for (const c of compilationsById.values()) {
    if (!c.author || seen.has(c.author)) continue;
    seen.add(c.author);
    if (authorSlug(c.author) === wanted) return c.author;
  }
  return null;
}

function slugify(name) {
  return (name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function fnv1aHex(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Admin-only: load every /allowlist entry so the "assign author" dropdowns can
// include friends who haven't signed in yet. Rules block non-admin reads.
export async function loadAllowlist() {
  const snap = await getDocs(collection(db, 'allowlist'));
  allowlistByEmail.clear();
  snap.forEach((d) => allowlistByEmail.set(d.id.toLowerCase(), { email: d.id, ...d.data() }));
}

// Union of /users and /allowlist keyed by lowercased email. /users wins on
// displayName conflicts. Each entry: { email, displayName, avatarPath, linked }.
// `linked` is true when the user has signed in at least once (has a /users doc).
export function allAuthorOptions() {
  const byEmail = new Map();
  for (const u of usersByEmail.values()) {
    const key = (u.email || '').toLowerCase();
    if (!key) continue;
    byEmail.set(key, {
      email: key,
      displayName: u.displayName || key,
      avatarPath: u.avatarPath || null,
      linked: true,
    });
  }
  for (const a of allowlistByEmail.values()) {
    const key = (a.email || '').toLowerCase();
    if (!key || byEmail.has(key)) continue;
    byEmail.set(key, {
      email: key,
      displayName: key,
      avatarPath: null,
      linked: false,
    });
  }
  return [...byEmail.values()].sort((x, y) =>
    (x.displayName || '').localeCompare(y.displayName || '', 'fr'),
  );
}

// Mutate a user record after the boot fetch — used after the current user
// updates their own profile (displayName / avatar) so the rest of the SPA
// sees the change without a reload.
export function updateUserLocal(email, patch) {
  const key = email.toLowerCase();
  const u = usersByEmail.get(key) || { email: key };
  Object.assign(u, patch);
  usersByEmail.set(key, u);
}

// Build a Track (the shape used by the player queue) from a songId.
// Returns null if the song isn't in the catalog (defensive — shouldn't happen).
export function trackFromSongId(songId) {
  const s = songsById.get(songId);
  if (!s) return null;
  const comp = compilationsById.get(s.compilationId);
  return {
    songId,
    storagePath: s.storagePath,
    title: s.title || 'Sans titre',
    artist: s.artist || '',
    duration: s.duration || 0,
    compilationId: s.compilationId,
    compilationTitle: comp?.title || '',
    coverPath: comp?.coverPath || null,
  };
}
