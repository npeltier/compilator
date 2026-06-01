import { onCall, HttpsError } from 'firebase-functions/v2/https';
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
 * Admin-only. Creates /allowlist/{email} so the user can sign in, and optionally
 * seeds /users/{email} with a displayName so authored content shows the right
 * name even before the user signs in for the first time.
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
  const db = admin.firestore();
  await db.collection('allowlist').doc(key).set({
    email: key,
    addedBy: callerEmail,
    addedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  const trimmed = (displayName || '').trim();
  if (trimmed) {
    await db.collection('users').doc(key).set({
      displayName: trimmed,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  return { email: key, displayName: trimmed || null };
});

/**
 * removeUser({ email })
 *
 * Admin-only. Removes /allowlist/{email} and /users/{email}. The Firebase Auth
 * record is NOT touched (you can disable that in the Firebase console if needed).
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
  return { email: key };
});

// Staging cleanup of /uploads/** is handled by a Cloud Storage lifecycle rule
// configured outside of code (auto-delete after 1 day) — no scheduled function,
// no Cloud Scheduler permissions, no per-execution cost.
