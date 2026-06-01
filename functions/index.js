import { onCall, HttpsError } from 'firebase-functions/v2/https';
import admin from 'firebase-admin';

import { isAdminEmail, requireAllowlistedCaller } from './auth.js';
import {
  deleteCompilationFully,
  processSongFromStaging,
  replaceSongFromStaging,
  uploadCoverFromStaging,
} from './processing.js';

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

// Staging cleanup of /uploads/** is handled by a Cloud Storage lifecycle rule
// configured outside of code (auto-delete after 1 day) — no scheduled function,
// no Cloud Scheduler permissions, no per-execution cost.
