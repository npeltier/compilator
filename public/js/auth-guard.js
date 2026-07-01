// Shell-level auth guard. The SPA boot script calls `requireAuth()` once on
// load; pages that need admin privileges call `requireAdmin()`. Both redirect
// the user to /login.html (or / for non-admins on admin-only pages) when the
// check fails.
//
// Admin membership is stored in Firestore at /admins/{emailLowercase} (mirrors
// /allowlist). We cache the result per session so views can call isAdmin()
// synchronously after the initial async resolution.

import { auth, db, functions } from './firebase-init.js';
import {
  onAuthStateChanged,
  signOut,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js';
import {
  doc,
  getDoc,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js';
import {
  httpsCallable,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js';

let adminCache = null; // { email: string, isAdmin: bool } — single-session cache

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

// Record the current (signed-in but not-allowlisted) user as a pending access
// request so an admin can approve or deny them from the Membres screen. The
// server callable reads the caller's email from the auth token. Best-effort —
// never throws into the caller, since we sign the user out immediately after.
export async function recordAccessRequest() {
  try {
    await httpsCallable(functions, 'requestAccess')();
  } catch (err) {
    console.warn('requestAccess failed', err);
  }
}

// Async check against /admins/{email}. Result cached for the session.
export async function isAdmin(email) {
  const e = (email || '').toLowerCase();
  if (!e) return false;
  if (adminCache && adminCache.email === e) return adminCache.isAdmin;
  const snap = await getDoc(doc(db, 'admins', e));
  adminCache = { email: e, isAdmin: snap.exists() };
  return adminCache.isAdmin;
}

// Synchronous fast-path for code that runs after `requireAuth()` resolved.
// Returns null if isAdmin hasn't been resolved yet for the given email.
export function isAdminSync(email) {
  const e = (email || '').toLowerCase();
  return adminCache && adminCache.email === e ? adminCache.isAdmin : null;
}

export async function requireAuth({ redirectTo = '/login.html' } = {}) {
  const user = await waitForAuthState();
  if (!user) {
    location.replace(`${redirectTo}?next=${encodeURIComponent(location.pathname + location.search)}`);
    return new Promise(() => {});
  }
  const ok = await isAllowlisted(user.email);
  if (!ok) {
    await recordAccessRequest();
    await signOut(auth);
    location.replace(`${redirectTo}?error=not_allowlisted`);
    return new Promise(() => {});
  }
  // Pre-resolve admin status so views can call isAdminSync afterwards.
  await isAdmin(user.email);
  hideAdminLinksFor(user);
  return user;
}

export async function requireAdmin({ redirectTo = '/' } = {}) {
  const user = await requireAuth();
  if (!(await isAdmin(user.email))) {
    location.replace(redirectTo);
    return new Promise(() => {});
  }
  return user;
}

// Removes admin-only nav links if the current user isn't an admin.
// Mark links with `data-admin-only` in the HTML; this strips them at runtime.
function hideAdminLinksFor(user) {
  if (isAdminSync(user.email)) return;
  document.querySelectorAll('[data-admin-only]').forEach((el) => el.remove());
}

export async function logout() {
  await signOut(auth);
  location.assign('/login.html');
}
