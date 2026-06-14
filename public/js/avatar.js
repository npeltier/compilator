// Avatar helpers — used by every view that mentions an author. Resolves the
// /avatars/{emailLower}.jpg download URL on demand (cached), falls back to a
// colored initial when no avatar is set.

import { storage } from './firebase-init.js';
import {
  ref as storageRef,
  getDownloadURL,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-storage.js';
import { displayNameFor, getUser } from './catalog.js';

const urlCache = new Map(); // avatarPath → download URL
const missing = new Set();  // avatarPaths known to 404 — don't refetch this session

const LS_KEY = 'avatar_url_cache';
const TTL_MS = 24 * 60 * 60 * 1000; // 24 h — URLs are signed but long-lived

function lsLoad() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const entries = JSON.parse(raw);
    const now = Date.now();
    for (const [path, { url, ts }] of Object.entries(entries)) {
      if (now - ts < TTL_MS) urlCache.set(path, url);
    }
  } catch (_) { /* ignore corrupt data */ }
}

function lsSave(path, url) {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const entries = raw ? JSON.parse(raw) : {};
    entries[path] = { url, ts: Date.now() };
    localStorage.setItem(LS_KEY, JSON.stringify(entries));
  } catch (_) { /* quota or private-mode — silent */ }
}

function lsDelete(path) {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const entries = JSON.parse(raw);
    delete entries[path];
    localStorage.setItem(LS_KEY, JSON.stringify(entries));
  } catch (_) {}
}

lsLoad();

function initialOf(name) {
  return (name || '?')[0]?.toUpperCase() || '?';
}

// Returns an HTML string for a small inline avatar pill. `email` is the author
// identity (lowercased email); we resolve the user doc to find avatarPath and
// fall back to the displayName / email-local-part for the placeholder initial.
// `size` is one of 'xs' (16px), 'sm' (22px), 'md' (40px), 'lg' (120px).
export function avatarHTML(email, { size = 'sm', avatarPath = null } = {}) {
  const path = avatarPath ?? getUser(email)?.avatarPath ?? null;
  const initial = initialOf(displayNameFor(email));
  // Always start as a placeholder showing the initial; paintAvatars swaps in the
  // image (and drops the initial) once it resolves. If there's no avatar — or it
  // 404s — the initial stays, so we never show a blank circle.
  const dataAttr = path && !missing.has(path) ? ` data-avatar="${path}"` : '';
  return `<span class="avatar avatar-${size} placeholder"${dataAttr}>${initial}</span>`;
}

// Resolve every `[data-avatar]` element inside `root` to its real background
// image. Safe to call multiple times — cached (successes and 404s alike).
export async function paintAvatars(root) {
  const els = root.querySelectorAll('[data-avatar]');
  for (const el of els) {
    const path = el.dataset.avatar;
    if (!path) continue;
    if (missing.has(path)) { el.removeAttribute('data-avatar'); continue; }
    if (urlCache.has(path)) {
      paint(el, urlCache.get(path));
      continue;
    }
    getDownloadURL(storageRef(storage, path))
      .then((url) => {
        urlCache.set(path, url);
        lsSave(path, url);
        paint(el, url);
      })
      .catch(() => {
        // Object missing/unreadable — remember it so we don't refetch on every
        // render, and leave the placeholder initial in place.
        missing.add(path);
        el.removeAttribute('data-avatar');
      });
  }
}

function paint(el, url) {
  el.style.backgroundImage = `url(${url})`;
  el.classList.remove('placeholder');
  el.textContent = '';
  el.removeAttribute('data-avatar');
}

// Resolve a single path to its URL (used for the big profile-page avatar).
export async function avatarUrl(path) {
  if (!path || missing.has(path)) return null;
  if (urlCache.has(path)) return urlCache.get(path);
  try {
    const url = await getDownloadURL(storageRef(storage, path));
    urlCache.set(path, url);
    lsSave(path, url);
    return url;
  } catch (_) {
    missing.add(path);
    return null;
  }
}

// Invalidate one path in the local URL cache — call after a re-upload so the
// next paint refetches the (now updated) image. Storage download URLs include
// a token that changes on overwrite, so without invalidation we'd keep showing
// the old image.
export function invalidateAvatar(path) {
  if (path) { urlCache.delete(path); missing.delete(path); lsDelete(path); }
}
