// Page-level auth guard. Pages that require sign-in import this and await
// `requireAuth()` before rendering. If the user is signed out OR not in the
// allowlist, they are redirected to /login.html.

import { auth, db } from './firebase-init.js';
import {
  onAuthStateChanged,
  signOut,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js';
import {
  doc,
  getDoc,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js';

// Admins can see /migrate.html and other privileged tools.
// Client-side only (Firestore rules still enforce per-user ownership for writes).
export const ADMIN_EMAILS = new Set(['peltier.nicolas@gmail.com']);

export function isAdminEmail(email) {
  return !!email && ADMIN_EMAILS.has(email.toLowerCase());
}

function waitForAuthState() {
  return new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, (user) => {
      unsub();
      resolve(user);
    });
  });
}

export async function isAllowlisted(email) {
  if (!email) return false;
  const snap = await getDoc(doc(db, 'allowlist', email.toLowerCase()));
  return snap.exists();
}

export async function requireAuth({ redirectTo = '/login.html' } = {}) {
  const user = await waitForAuthState();
  if (!user) {
    location.replace(`${redirectTo}?next=${encodeURIComponent(location.pathname + location.search)}`);
    return new Promise(() => {});
  }
  const ok = await isAllowlisted(user.email);
  if (!ok) {
    await signOut(auth);
    location.replace(`${redirectTo}?error=not_allowlisted`);
    return new Promise(() => {});
  }
  hideAdminLinksFor(user);
  return user;
}

export async function requireAdmin({ redirectTo = '/' } = {}) {
  const user = await requireAuth();
  if (!isAdminEmail(user.email)) {
    location.replace(redirectTo);
    return new Promise(() => {});
  }
  return user;
}

// Removes admin-only nav links if the current user isn't an admin.
// Mark links with `data-admin-only` in the HTML; this strips them at runtime.
function hideAdminLinksFor(user) {
  if (isAdminEmail(user.email)) return;
  document.querySelectorAll('[data-admin-only]').forEach((el) => el.remove());
}

export async function logout() {
  await signOut(auth);
  location.assign('/login.html');
}
