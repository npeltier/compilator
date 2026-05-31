import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import admin from 'firebase-admin';

import { requireAllowlistedCaller } from './auth.js';
import { processSongFromStaging, uploadCoverFromStaging } from './processing.js';

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
 * cleanupStaging — daily sweep of /uploads/** older than 24 h.
 */
export const cleanupStaging = onSchedule('every 24 hours', async () => {
  const bucket = admin.storage().bucket();
  const [files] = await bucket.getFiles({ prefix: 'uploads/' });
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let deleted = 0;
  await Promise.all(files.map(async (f) => {
    const [meta] = await f.getMetadata();
    const updated = new Date(meta.updated).getTime();
    if (updated < cutoff) {
      await f.delete();
      deleted++;
    }
  }));
  console.log(`cleanupStaging: deleted ${deleted} stale files`);
});
