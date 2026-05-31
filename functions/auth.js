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
