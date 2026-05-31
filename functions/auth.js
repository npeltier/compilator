import admin from 'firebase-admin';
import { HttpsError } from 'firebase-functions/v2/https';

if (admin.apps.length === 0) {
  admin.initializeApp();
}

export async function requireAllowlistedCaller(auth) {
  if (!auth || !auth.uid) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }
  const email = auth.token?.email;
  if (!email) {
    throw new HttpsError('permission-denied', 'Email missing from token.');
  }
  const snap = await admin.firestore().doc(`allowlist/${email.toLowerCase()}`).get();
  if (!snap.exists) {
    throw new HttpsError('permission-denied', 'Email not on allowlist.');
  }
  return { uid: auth.uid, email: email.toLowerCase() };
}

// Server-side admin check. Mirrors the Firestore rule `isAdmin()` — looks up
// /admins/{emailLowercase} via the Admin SDK.
export async function isAdminEmail(email) {
  if (!email) return false;
  const snap = await admin.firestore().doc(`admins/${email.toLowerCase()}`).get();
  return snap.exists;
}
