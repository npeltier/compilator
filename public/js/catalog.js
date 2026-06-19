// Central in-memory cache for the music catalog.
//
// Boot (loadCatalog): fetches compilations + users — enough to render all views.
// Lazy (ensureSongsLoaded): collectionGroup('songs') — deferred until first
//   shuffle click so the expensive read doesn't block the initial paint.
//
//   - compilationsById:    Map<compId, compDoc>
//   - usersByEmail:        Map<emailLower, userDoc & { email }>
//   - songsById:           Map<songId, songDoc & { compilationId }>  ← lazy

import { db } from './firebase-init.js';
import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  getDocsFromCache,
  orderBy,
  query,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js';

const songsById = new Map();
const compilationsById = new Map();
const usersByEmail = new Map();
const allowlistByEmail = new Map();   // admin-only
let loaded = false;
let songsLoaded = false;
let songsLoadingPromise = null;

// ---------------------------------------------------------------------------
// Catalog cache freshness.
//
// `/meta/catalog` holds monotonic revision counters bumped by Firestore
// triggers on every catalog write (see functions/index.js). On boot we read
// that single doc from the server (1 read) and compare each counter to the one
// we last synced (kept in localStorage). When they match, we serve the heavy
// collection queries straight from Firestore's local cache — zero server reads
// and instant. When they differ (or the cache is cold / missing), we fall back
// to a server read and record the new revision.
//
// Net effect for our rarely-changing catalog: ~1 read per session instead of
// (compilations + users [+ songs]), and near-instant repeat loads. Degrades
// gracefully — if anything goes wrong we just read from the server as before.
const REV_KEY = 'catalog.rev.v1';

async function fetchServerRevs() {
  try {
    const snap = await getDoc(doc(db, 'meta', 'catalog'));
    const d = snap.exists() ? snap.data() : {};
    return { coreRev: d.coreRev ?? 0, songsRev: d.songsRev ?? 0, ok: true };
  } catch {
    // Sentinel unreachable (offline / rules) — force server reads downstream.
    return { coreRev: null, songsRev: null, ok: false };
  }
}

function loadStoredRevs() {
  try { return JSON.parse(localStorage.getItem(REV_KEY)) || {}; } catch { return {}; }
}

function storeRev(field, value) {
  if (value == null) return;
  try {
    localStorage.setItem(REV_KEY, JSON.stringify({ ...loadStoredRevs(), [field]: value }));
  } catch { /* private mode / quota — caching just won't persist */ }
}

let serverRevsPromise = null;
function serverRevs() {
  if (!serverRevsPromise) serverRevsPromise = fetchServerRevs();
  return serverRevsPromise;
}

export async function loadCatalog() {
  if (loaded) return;

  const revs = await serverRevs();
  const stored = loadStoredRevs();
  const useCache = revs.ok && revs.coreRev != null && stored.coreRev === revs.coreRev;

  const compsQ = query(collection(db, 'compilations'), orderBy('createdAt', 'asc'));
  const usersQ = collection(db, 'users');

  let compsSnap = null;
  let usersSnap = null;
  if (useCache) {
    try {
      [compsSnap, usersSnap] = await Promise.all([getDocsFromCache(compsQ), getDocsFromCache(usersQ)]);
      // Rev matched but the cache is empty (cleared IndexedDB, new device,
      // dev memory-cache) — don't trust it; fall through to a server read.
      if (compsSnap.empty && usersSnap.empty) { compsSnap = null; usersSnap = null; }
    } catch {
      compsSnap = null; usersSnap = null;
    }
  }
  if (!compsSnap) {
    [compsSnap, usersSnap] = await Promise.all([getDocs(compsQ), getDocs(usersQ)]);
    storeRev('coreRev', revs.coreRev);
  }

  usersByEmail.clear();
  usersSnap.forEach((d) => {
    usersByEmail.set(d.id.toLowerCase(), { email: d.id, ...d.data() });
  });

  compilationsById.clear();
  compsSnap.forEach((d) => compilationsById.set(d.id, { id: d.id, ...d.data() }));

  loaded = true;
}

export function ensureSongsLoaded() {
  if (songsLoaded) return Promise.resolve();
  if (songsLoadingPromise) return songsLoadingPromise;
  songsLoadingPromise = (async () => {
    const revs = await serverRevs();
    const stored = loadStoredRevs();
    const useCache = revs.ok && revs.songsRev != null && stored.songsRev === revs.songsRev;
    const songsQ = collectionGroup(db, 'songs');

    let snap = null;
    if (useCache) {
      try {
        snap = await getDocsFromCache(songsQ);
        if (snap.empty) snap = null;
      } catch { snap = null; }
    }
    if (!snap) {
      snap = await getDocs(songsQ);
      storeRev('songsRev', revs.songsRev);
    }

    songsById.clear();
    snap.forEach((d) => {
      const parentComp = d.ref.parent.parent;
      if (!parentComp) return;
      songsById.set(d.id, { id: d.id, compilationId: parentComp.id, ...d.data() });
    });
    songsLoaded = true;
    songsLoadingPromise = null;
  })();
  return songsLoadingPromise;
}

export function getSong(id) { return songsById.get(id); }
export function allSongs() { return [...songsById.values()]; }
export function getCompilation(id) { return compilationsById.get(id); }
export function allCompilations() { return [...compilationsById.values()]; }

// Draft visibility. Drafts are private to their author (and admins) until
// published; everyone else must not see them in listings, search or shuffle.
// The current viewer is set once at boot (see app.js). Reads are allowlisted at
// the DB level — same friends-only tradeoff as reactions — so this is a
// client-side filter, not a security boundary.
let viewerEmail = '';
let viewerIsAdmin = false;
export function setViewer(email, isAdmin) {
  viewerEmail = (email || '').toLowerCase();
  viewerIsAdmin = !!isAdmin;
}
export function isCompVisible(comp) {
  if (!comp) return false;
  return comp.status === 'published' || viewerIsAdmin || comp.author === viewerEmail;
}
// Compilations the current viewer may see (published + own/all drafts).
export function visibleCompilations() {
  return allCompilations().filter(isCompVisible);
}
// Songs whose compilation is visible to the viewer — used by shuffle queues.
export function visibleSongs() {
  return allSongs().filter((s) => isCompVisible(compilationsById.get(s.compilationId)));
}
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

// Insert or update a compilation in the in-memory catalog after a create/save,
// so the home banner, the upload editor and /c/:id reflect it without a reload.
export function upsertCompilationLocal(id, patch) {
  const existing = compilationsById.get(id) || { id };
  const merged = { ...existing, ...patch, id };
  compilationsById.set(id, merged);
  return merged;
}

// Remove a compilation from the in-memory catalog after a delete.
export function removeCompilationLocal(id) {
  compilationsById.delete(id);
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
