import { onCall, HttpsError } from 'firebase-functions/v2/https';
import admin from 'firebase-admin';

import { isAdminEmail, requireAllowlistedCaller } from './auth.js';
import {
  processSongFromStaging,
  replaceTrackSongFromStaging,
  uploadCoverFromStaging,
} from './processing.js';

if (admin.apps.length === 0) {
  admin.initializeApp();
}

/**
 * processSong({ tempPath, compilationId, order })
 *
 * The client uploads an MP3 directly to /uploads/{uid}/<uuid>.mp3 via the Firebase
 * Storage JS SDK (bypassing Function HTTP body limits), then calls this to dedupe,
 * file the song, and create the track row in the compilation.
 */
export const processSong = onCall({ memory: '512MiB', timeoutSeconds: 120 }, async (req) => {
  const { uid } = await requireAllowlistedCaller(req.auth);
  const { tempPath, compilationId, order } = req.data || {};
  if (!tempPath || !compilationId || order == null) {
    throw new HttpsError('invalid-argument', 'tempPath, compilationId, and order are required.');
  }
  // Enforce that the staging path belongs to the caller — defense in depth.
  if (!tempPath.startsWith(`uploads/${uid}/`)) {
    throw new HttpsError('permission-denied', 'tempPath must be in your /uploads/<uid>/ folder.');
  }
  // Ownership check on the compilation.
  const compSnap = await admin.firestore().collection('compilations').doc(compilationId).get();
  if (!compSnap.exists) {
    throw new HttpsError('not-found', 'Compilation not found.');
  }
  if (compSnap.data().authorUid !== uid) {
    throw new HttpsError('permission-denied', 'You are not the author of this compilation.');
  }
  try {
    return await processSongFromStaging({ tempPath, compilationId, order, uploaderUid: uid });
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
  const { uid } = await requireAllowlistedCaller(req.auth);
  const { tempPath, compilationId, ext } = req.data || {};
  if (!tempPath || !compilationId || !ext) {
    throw new HttpsError('invalid-argument', 'tempPath, compilationId, ext are required.');
  }
  if (!tempPath.startsWith(`uploads/${uid}/`)) {
    throw new HttpsError('permission-denied', 'tempPath must be in your /uploads/<uid>/ folder.');
  }
  const compSnap = await admin.firestore().collection('compilations').doc(compilationId).get();
  if (!compSnap.exists) throw new HttpsError('not-found', 'Compilation not found.');
  if (compSnap.data().authorUid !== uid) {
    throw new HttpsError('permission-denied', 'You are not the author of this compilation.');
  }
  try {
    return await uploadCoverFromStaging({ tempPath, compilationId, ext, uploaderUid: uid });
  } catch (err) {
    console.error('uploadCover error', err);
    throw new HttpsError('internal', err.message || 'Failed to upload cover.');
  }
});

/**
 * replaceTrackSong({ tempPath, compilationId, trackId })
 *
 * Swap a track's audio binary in place. Used by the compilation edit mode's
 * 🔄 button. The compilation's author OR an admin may call this; the new file
 * goes through the same dedup pipeline as processSong. Per-track title/artist
 * overrides are preserved; only songId + duration are updated.
 */
export const replaceTrackSong = onCall({ memory: '512MiB', timeoutSeconds: 120 }, async (req) => {
  const { uid, email } = await requireAllowlistedCaller(req.auth);
  const { tempPath, compilationId, trackId } = req.data || {};
  if (!tempPath || !compilationId || !trackId) {
    throw new HttpsError('invalid-argument', 'tempPath, compilationId, and trackId are required.');
  }
  if (!tempPath.startsWith(`uploads/${uid}/`)) {
    throw new HttpsError('permission-denied', 'tempPath must be in your /uploads/<uid>/ folder.');
  }
  const compSnap = await admin.firestore().collection('compilations').doc(compilationId).get();
  if (!compSnap.exists) {
    throw new HttpsError('not-found', 'Compilation not found.');
  }
  const comp = compSnap.data();
  if (comp.authorUid !== uid && !(await isAdminEmail(email))) {
    throw new HttpsError('permission-denied', 'You are not the author of this compilation.');
  }
  try {
    return await replaceTrackSongFromStaging({
      tempPath,
      compilationId,
      trackId,
      uploaderUid: uid,
      callerEmail: email,
    });
  } catch (err) {
    console.error('replaceTrackSong error', err);
    throw new HttpsError('internal', err.message || 'Failed to replace track.');
  }
});

// Staging cleanup of /uploads/** is handled by a Cloud Storage lifecycle rule
// configured outside of code (auto-delete after 1 day) — no scheduled function,
// no Cloud Scheduler permissions, no per-execution cost.
