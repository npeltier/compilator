// Avatar helpers — used by every view that mentions an author. Resolves the
// /avatars/{uid}.jpg download URL on demand (cached), falls back to a colored
// initial when no avatar is set.

import { storage } from './firebase-init.js';
import {
  ref as storageRef,
  getDownloadURL,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-storage.js';
import { getUserByDisplayName } from './catalog.js';

const urlCache = new Map(); // avatarPath → download URL

function initialOf(name) {
  return (name || '?')[0]?.toUpperCase() || '?';
}

// Returns an HTML string for a small inline avatar pill. `size` is one of
// 'xs' (16px), 'sm' (22px), 'md' (40px), 'lg' (120px).
export function avatarHTML(displayName, { size = 'sm', avatarPath = null } = {}) {
  const path = avatarPath ?? getUserByDisplayName(displayName)?.avatarPath ?? null;
  const initial = initialOf(displayName);
  const cls = `avatar avatar-${size}${path ? '' : ' placeholder'}`;
  const dataAttr = path ? ` data-avatar="${path}"` : '';
  return `<span class="${cls}"${dataAttr}>${path ? '' : initial}</span>`;
}

// Resolve every `[data-avatar]` element inside `root` to its real background
// image. Safe to call multiple times — cached.
export async function paintAvatars(root) {
  const els = root.querySelectorAll('[data-avatar]');
  for (const el of els) {
    const path = el.dataset.avatar;
    if (!path) continue;
    if (urlCache.has(path)) {
      el.style.backgroundImage = `url(${urlCache.get(path)})`;
      el.removeAttribute('data-avatar');
      continue;
    }
    getDownloadURL(storageRef(storage, path))
      .then((url) => {
        urlCache.set(path, url);
        el.style.backgroundImage = `url(${url})`;
        el.removeAttribute('data-avatar');
      })
      .catch(() => { /* keep placeholder */ });
  }
}

// Resolve a single path to its URL (used for the big profile-page avatar).
export async function avatarUrl(path) {
  if (!path) return null;
  if (urlCache.has(path)) return urlCache.get(path);
  try {
    const url = await getDownloadURL(storageRef(storage, path));
    urlCache.set(path, url);
    return url;
  } catch (_) {
    return null;
  }
}

// Invalidate one path in the local URL cache — call after a re-upload so the
// next paint refetches the (now updated) image. Storage download URLs include
// a token that changes on overwrite, so without invalidation we'd keep showing
// the old image.
export function invalidateAvatar(path) {
  if (path) urlCache.delete(path);
}
