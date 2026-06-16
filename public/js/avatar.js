// Avatar helpers — used by every view that mentions an author. Resolves the
// /avatars/{emailLower}.jpg download URL on demand and falls back to a coloured
// initial when no avatar is set (or the file is missing).
//
// URL resolution + caching (in-memory + localStorage), negative-caching of 404s
// and concurrent-resolve de-duping all live in image-url.js, shared with covers.

import { resolveImageUrl, invalidateImageUrl } from './image-url.js';
import { displayNameFor, getUser } from './catalog.js';

function initialOf(name) {
  return (name || '?')[0]?.toUpperCase() || '?';
}

// Returns an HTML string for a small inline avatar pill. `email` is the author
// identity (lowercased email); we resolve the user doc to find avatarPath and
// fall back to the displayName / email-local-part for the placeholder initial.
// `size` is one of 'xs' | 'sm' | 'md' | 'lg' | 'xl'.
//
// Always starts as a placeholder showing the initial; paintAvatars swaps in the
// image (and drops the initial) once it resolves. If there's no avatar — or it
// 404s — the initial stays, so we never show a blank circle.
export function avatarHTML(email, { size = 'sm', avatarPath = null } = {}) {
  const path = avatarPath ?? getUser(email)?.avatarPath ?? null;
  const initial = initialOf(displayNameFor(email));
  const dataAttr = path ? ` data-avatar="${path}"` : '';
  return `<span class="avatar avatar-${size} placeholder"${dataAttr}>${initial}</span>`;
}

// Resolve every `[data-avatar]` element inside `root` to its real background
// image. Safe to call multiple times — cached, and each element is claimed once.
export async function paintAvatars(root) {
  for (const el of root.querySelectorAll('[data-avatar]')) {
    const path = el.dataset.avatar;
    if (!path) continue;
    el.removeAttribute('data-avatar'); // claim it — avoids duplicate processing
    resolveImageUrl(path).then((url) => {
      if (!url) return; // missing/unreadable — keep the placeholder initial
      el.style.backgroundImage = `url(${url})`;
      el.classList.remove('placeholder');
      el.textContent = '';
    });
  }
}

// Resolve a single path to its URL (used for the big profile-page avatar).
export function avatarUrl(path) {
  return resolveImageUrl(path);
}

// Invalidate one path's cached URL — call after a re-upload so the next paint
// refetches the (now updated) image instead of the stale/missing one.
export function invalidateAvatar(path) {
  invalidateImageUrl(path);
}
