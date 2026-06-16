// Shared persistent cache for Storage download URLs (covers + avatars).
//
// Why: getDownloadURL() resolves a path to a tokenised URL, but that metadata
// request is served `Cache-Control: private, max-age=0` — never cached. The
// image bytes themselves ARE cached for a year (the URL's token is stable), so
// the only repeated cost on each navigation is the metadata roundtrip. By
// remembering the resolved URL (in memory + localStorage) we skip getDownloadURL
// on repeat views and let the browser serve the bytes from its HTTP cache.
//
// Also negative-caches 404s (so a missing image isn't refetched every render)
// and de-dupes concurrent resolves of the same path (e.g. one author's avatar
// shown across many chips/cards).

import { storage } from './firebase-init.js';
import {
  ref as storageRef,
  getDownloadURL,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-storage.js';

const mem = new Map();       // path → resolved download URL
const inflight = new Map();  // path → Promise<url|null> (de-dupe concurrent resolves)
const missing = new Set();   // paths known to 404 this session
const LS_KEY = 'image_url_cache_v1';
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — bounds staleness if an image is re-uploaded

function lsLoad() {
  try {
    const entries = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    const now = Date.now();
    for (const [path, { url, ts }] of Object.entries(entries)) {
      if (now - ts < TTL_MS) mem.set(path, url);
    }
  } catch (_) { /* ignore corrupt/absent */ }
}

function lsSave(path, url) {
  try {
    const entries = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    entries[path] = { url, ts: Date.now() };
    localStorage.setItem(LS_KEY, JSON.stringify(entries));
  } catch (_) { /* quota / private mode — cache just won't persist */ }
}

function lsDelete(path) {
  try {
    const entries = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    delete entries[path];
    localStorage.setItem(LS_KEY, JSON.stringify(entries));
  } catch (_) { /* ignore */ }
}

lsLoad();

// Resolve a Storage path to its download URL, caching the result. Returns null
// on failure (caller keeps its placeholder); the failure is remembered so we
// don't refetch a missing object on every render.
export async function resolveImageUrl(path) {
  if (!path || missing.has(path)) return null;
  if (mem.has(path)) return mem.get(path);
  if (inflight.has(path)) return inflight.get(path);
  const promise = getDownloadURL(storageRef(storage, path))
    .then((url) => { mem.set(path, url); lsSave(path, url); inflight.delete(path); return url; })
    .catch(() => { missing.add(path); inflight.delete(path); return null; });
  inflight.set(path, promise);
  return promise;
}

// Drop a cached URL (positive or negative) — call after re-uploading so the next
// resolve fetches the fresh (rotated-token) URL instead of a stale/missing one.
export function invalidateImageUrl(path) {
  if (path) { mem.delete(path); missing.delete(path); inflight.delete(path); lsDelete(path); }
}

// Cover-flavoured aliases (used by the compilation/home/author/profile views).
export const coverUrl = resolveImageUrl;
export const invalidateCover = invalidateImageUrl;
