import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import admin from 'firebase-admin';

import { isAdminEmail, requireAllowlistedCaller } from './auth.js';
import {
  deleteCompilationFully,
  processSongFromStaging,
  replaceSongFromStaging,
  uploadCoverFromStaging,
} from './processing.js';
import { FieldValue } from 'firebase-admin/firestore';

if (admin.apps.length === 0) {
  admin.initializeApp();
}

async function loadCompilationOrThrow(compilationId) {
  const snap = await admin.firestore().collection('compilations').doc(compilationId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Compilation not found.');
  return snap.data();
}

async function requireAuthorOrAdmin(comp, email) {
  if (comp.author !== email && !(await isAdminEmail(email))) {
    throw new HttpsError('permission-denied', 'You are not the author of this compilation.');
  }
}

/**
 * processSong({ tempPath, compilationId, order })
 *
 * The client uploads an MP3 directly to /uploads/{uid}/<uuid>.mp3 via the Firebase
 * Storage JS SDK (bypassing Function HTTP body limits), then calls this to dedupe
 * the binary and create the song row in the compilation.
 */
export const processSong = onCall({ memory: '512MiB', timeoutSeconds: 120 }, async (req) => {
  const { uid, email } = await requireAllowlistedCaller(req.auth);
  const { tempPath, compilationId, order } = req.data || {};
  if (!tempPath || !compilationId || order == null) {
    throw new HttpsError('invalid-argument', 'tempPath, compilationId, and order are required.');
  }
  if (!tempPath.startsWith(`uploads/${uid}/`)) {
    throw new HttpsError('permission-denied', 'tempPath must be in your /uploads/<uid>/ folder.');
  }
  const comp = await loadCompilationOrThrow(compilationId);
  await requireAuthorOrAdmin(comp, email);
  try {
    return await processSongFromStaging({ tempPath, compilationId, order });
  } catch (err) {
    console.error('processSong error', err);
    throw new HttpsError('internal', err.message || 'Failed to process song.');
  }
});

/**
 * uploadCover({ tempPath, compilationId, ext })
 *
 * Move a staged cover image (uploaded to /uploads/{uid}/cover-...) into /covers/{compId}.{ext}.
 */
export const uploadCover = onCall({ memory: '256MiB', timeoutSeconds: 60 }, async (req) => {
  const { uid, email } = await requireAllowlistedCaller(req.auth);
  const { tempPath, compilationId, ext } = req.data || {};
  if (!tempPath || !compilationId || !ext) {
    throw new HttpsError('invalid-argument', 'tempPath, compilationId, ext are required.');
  }
  if (!tempPath.startsWith(`uploads/${uid}/`)) {
    throw new HttpsError('permission-denied', 'tempPath must be in your /uploads/<uid>/ folder.');
  }
  const comp = await loadCompilationOrThrow(compilationId);
  await requireAuthorOrAdmin(comp, email);
  try {
    return await uploadCoverFromStaging({ tempPath, compilationId, ext });
  } catch (err) {
    console.error('uploadCover error', err);
    throw new HttpsError('internal', err.message || 'Failed to upload cover.');
  }
});

/**
 * replaceSong({ tempPath, compilationId, songId })
 *
 * Swap a song's audio binary in place. Used by the compilation edit mode's 🔄
 * button. The compilation's author OR an admin may call this; the new file
 * goes through the same dedup pipeline as processSong. Title/artist on the
 * song doc are preserved; only hash/storagePath/duration update.
 */
export const replaceSong = onCall({ memory: '512MiB', timeoutSeconds: 120 }, async (req) => {
  const { uid, email } = await requireAllowlistedCaller(req.auth);
  const { tempPath, compilationId, songId } = req.data || {};
  if (!tempPath || !compilationId || !songId) {
    throw new HttpsError('invalid-argument', 'tempPath, compilationId, and songId are required.');
  }
  if (!tempPath.startsWith(`uploads/${uid}/`)) {
    throw new HttpsError('permission-denied', 'tempPath must be in your /uploads/<uid>/ folder.');
  }
  const comp = await loadCompilationOrThrow(compilationId);
  await requireAuthorOrAdmin(comp, email);
  try {
    return await replaceSongFromStaging({ tempPath, compilationId, songId, callerEmail: email });
  } catch (err) {
    console.error('replaceSong error', err);
    throw new HttpsError('internal', err.message || 'Failed to replace song.');
  }
});

/**
 * deleteCompilation({ compilationId })
 *
 * Atomically delete a compilation, its songs subcollection, its cover, and
 * any /store/ binaries that no other compilation references afterwards.
 */
export const deleteCompilation = onCall({ memory: '512MiB', timeoutSeconds: 300 }, async (req) => {
  const { email } = await requireAllowlistedCaller(req.auth);
  const { compilationId } = req.data || {};
  if (!compilationId) {
    throw new HttpsError('invalid-argument', 'compilationId is required.');
  }
  const comp = await loadCompilationOrThrow(compilationId);
  await requireAuthorOrAdmin(comp, email);
  try {
    return await deleteCompilationFully({ compilationId, callerEmail: email });
  } catch (err) {
    console.error('deleteCompilation error', err);
    throw new HttpsError('internal', err.message || 'Failed to delete compilation.');
  }
});

/**
 * upsertUser({ email, displayName? })
 *
 * Admin-only. Creates /allowlist/{email}, optionally seeds /users/{email}
 * with a displayName, and — if the email has no Firebase Auth account yet —
 * creates one with a random temporary password and sends a password-reset
 * email so the new member can set their own password.
 *
 * Returns { email, displayName, authCreated, resetLink? }. `resetLink` is only
 * populated when running against the Auth emulator (no real email is sent in
 * the emulator), so dev/test callers can surface it instead.
 */
export const upsertUser = onCall({ memory: '256MiB', timeoutSeconds: 30 }, async (req) => {
  const { email: callerEmail } = await requireAllowlistedCaller(req.auth);
  if (!(await isAdminEmail(callerEmail))) {
    throw new HttpsError('permission-denied', 'Admin only.');
  }
  const { email, displayName } = req.data || {};
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    throw new HttpsError('invalid-argument', 'A valid email is required.');
  }
  const key = email.toLowerCase().trim();
  const trimmed = (displayName || '').trim();
  const db = admin.firestore();

  // Allowlist + optional display name.
  await db.collection('allowlist').doc(key).set({
    email: key,
    addedBy: callerEmail,
    addedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  if (trimmed) {
    await db.collection('users').doc(key).set({
      displayName: trimmed,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  // Make sure a Firebase Auth account exists for this email so the person can
  // actually sign in. If we just created it, the caller (frontend) will follow
  // up with sendPasswordResetEmail() so the new member gets an invite email.
  const auth = admin.auth();
  let authCreated = false;
  try {
    await auth.getUserByEmail(key);
  } catch (err) {
    if (err.code !== 'auth/user-not-found') throw err;
    const tempPassword = `tmp-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
    await auth.createUser({
      email: key,
      password: tempPassword,
      emailVerified: false,
      ...(trimmed ? { displayName: trimmed } : {}),
    });
    authCreated = true;
  }

  return { email: key, displayName: trimmed || null, authCreated };
});

/**
 * removeUser({ email })
 *
 * Admin-only. Removes /allowlist/{email}, /users/{email}, and the Firebase
 * Auth account if it exists.
 */
export const removeUser = onCall({ memory: '256MiB', timeoutSeconds: 30 }, async (req) => {
  const { email: callerEmail } = await requireAllowlistedCaller(req.auth);
  if (!(await isAdminEmail(callerEmail))) {
    throw new HttpsError('permission-denied', 'Admin only.');
  }
  const { email } = req.data || {};
  if (!email) throw new HttpsError('invalid-argument', 'email is required.');
  const key = email.toLowerCase().trim();
  if (key === callerEmail) {
    throw new HttpsError('failed-precondition', "You can't remove yourself.");
  }
  const db = admin.firestore();
  await db.collection('allowlist').doc(key).delete();
  await db.collection('users').doc(key).delete().catch(() => {});
  try {
    const u = await admin.auth().getUserByEmail(key);
    await admin.auth().deleteUser(u.uid);
  } catch (err) {
    if (err.code !== 'auth/user-not-found') console.warn('deleteUser failed', err);
  }
  return { email: key };
});

// ---------------------------------------------------------------------------
// Catalog version sentinel
//
// The client caches the catalog (compilations + users on boot, songs lazily)
// in Firestore's local persistence and only re-reads from the server when a
// revision counter changes. These triggers bump those counters on ANY write to
// the relevant collections — covering both the callables above and the direct
// client-side writes in upload.js / compilation.js / profile.js / migrate.js.
//
//   - coreRev:  compilations + users  (the boot payload)
//   - songsRev: songs                 (the lazy collectionGroup payload)
//
// `/meta/catalog` lives outside the watched collections, so bumping it never
// re-triggers these functions.
const SENTINEL = () => admin.firestore().doc('meta/catalog');

async function bumpRev(field) {
  await SENTINEL().set({
    [field]: FieldValue.increment(1),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

export const onCompilationWrite = onDocumentWritten('compilations/{compId}', () => bumpRev('coreRev'));
export const onUserWrite = onDocumentWritten('users/{email}', () => bumpRev('coreRev'));
export const onSongWrite = onDocumentWritten('compilations/{compId}/songs/{songId}', () => bumpRev('songsRev'));

// Staging cleanup of /uploads/** is handled by a Cloud Storage lifecycle rule
// configured outside of code (auto-delete after 1 day) — no scheduled function,
// no Cloud Scheduler permissions, no per-execution cost.
