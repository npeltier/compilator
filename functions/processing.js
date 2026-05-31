import admin from 'firebase-admin';
import { getStorage } from 'firebase-admin/storage';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { parseBuffer } from 'music-metadata';

import { computeMp3Hash, getStorePath } from './hash.js';
import { isAdminEmail } from './auth.js';

if (admin.apps.length === 0) {
  admin.initializeApp();
}

/**
 * Hash + parse a buffer, dedupe against `/songs`, and either reuse the
 * matching song doc or create a new one (uploading the buffer to /store/).
 * Shared by processSongFromStaging and replaceTrackSongFromStaging.
 *
 * @returns {Promise<{songId:string, songData:object, dedupHit:boolean, metadata:object}>}
 */
async function resolveSongFromBuffer(buf, uploaderUid) {
  const db = getFirestore();
  const bucket = getStorage().bucket();

  const hash = await computeMp3Hash(buf);
  const metadata = await parseBuffer(buf, 'audio/mpeg');
  const { duration } = metadata.format || {};
  const { album, artist, year, title, track } = metadata.common || {};
  const trackNo = track && typeof track.no === 'number' ? track.no : null;

  const songsRef = db.collection('songs');
  const existing = await songsRef.where('hash', '==', hash).limit(1).get();

  if (!existing.empty) {
    const d = existing.docs[0];
    return { songId: d.id, songData: d.data(), dedupHit: true, metadata };
  }

  const storagePath = getStorePath(hash);
  await bucket.file(storagePath).save(buf, {
    metadata: { contentType: 'audio/mpeg' },
    resumable: false,
  });

  const songRef = songsRef.doc();
  const songData = {
    hash,
    storagePath,
    title: title || null,
    artist: artist || null,
    album: album || null,
    year: year || null,
    track: trackNo,
    duration: duration || null,
    uploaderUid,
    importDate: FieldValue.serverTimestamp(),
  };
  await songRef.set(songData);
  return { songId: songRef.id, songData, dedupHit: false, metadata };
}

/**
 * Process a song already uploaded to a staging path in Cloud Storage.
 * - Hashes + dedups against /songs.
 * - Creates /compilations/{compilationId}/tracks/{trackId}.
 * - Fills in the compilation cover from ID3 APIC if it doesn't have one yet.
 * - Deletes the staging blob on success.
 */
export async function processSongFromStaging({ tempPath, compilationId, order, uploaderUid }) {
  if (!tempPath || !compilationId || order == null || !uploaderUid) {
    throw new Error('processSongFromStaging: missing tempPath/compilationId/order/uploaderUid');
  }

  const bucket = getStorage().bucket();
  const db = getFirestore();

  const stagingFile = bucket.file(tempPath);
  const [stagingBuf] = await stagingFile.download();

  const { songId, songData, dedupHit, metadata } = await resolveSongFromBuffer(stagingBuf, uploaderUid);
  const { picture } = metadata.common || {};

  // Append to compilation's tracks subcollection.
  const compRef = db.collection('compilations').doc(compilationId);
  const trackRef = compRef.collection('tracks').doc();
  await trackRef.set({
    order,
    songId,
    title: songData.title || null,
    artist: songData.artist || null,
    duration: songData.duration || null,
    addedAt: FieldValue.serverTimestamp(),
  });

  // Refresh denormalized counters on the compilation.
  await compRef.set({
    trackCount: FieldValue.increment(1),
    totalDuration: FieldValue.increment(songData.duration || 0),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  // ID3 cover fallback: if compilation has no cover and this song has APIC, use it.
  let coverWritten = false;
  if (picture && picture.length > 0) {
    const compSnap = await compRef.get();
    const comp = compSnap.exists ? compSnap.data() : null;
    if (comp && !comp.coverPath) {
      const pic = picture[0];
      const ext = (pic.format || 'image/jpeg').includes('png') ? 'png' : 'jpg';
      const coverPath = `covers/${compilationId}.${ext}`;
      await bucket.file(coverPath).save(Buffer.from(pic.data), {
        metadata: { contentType: pic.format || 'image/jpeg' },
        resumable: false,
      });
      await compRef.set({
        coverPath,
        coverSource: 'id3',
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      coverWritten = true;
    }
  }

  // Best-effort staging cleanup.
  try { await stagingFile.delete(); } catch (e) { /* ignore */ }

  return {
    songId,
    trackId: trackRef.id,
    dedupHit,
    title: songData.title,
    artist: songData.artist,
    duration: songData.duration,
    coverWritten,
  };
}

/**
 * Move a staged cover image to /covers/{compilationId}.{ext} and update the compilation.
 */
export async function uploadCoverFromStaging({ tempPath, compilationId, ext, uploaderUid }) {
  if (!tempPath || !compilationId || !ext || !uploaderUid) {
    throw new Error('uploadCoverFromStaging: missing arguments');
  }
  const bucket = getStorage().bucket();
  const db = getFirestore();
  const stagingFile = bucket.file(tempPath);
  const [buf] = await stagingFile.download();
  const safeExt = ext.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'jpg';
  const coverPath = `covers/${compilationId}.${safeExt}`;
  const contentType = safeExt === 'png' ? 'image/png' : 'image/jpeg';
  await bucket.file(coverPath).save(buf, {
    metadata: { contentType },
    resumable: false,
  });
  await db.collection('compilations').doc(compilationId).set({
    coverPath,
    coverSource: 'upload',
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  try { await stagingFile.delete(); } catch (e) { /* ignore */ }
  return { coverPath };
}

/**
 * Replace the audio binary of an existing track. The track row keeps its order
 * and any user-edited title/artist overrides; only the songId pointer and
 * duration update. Compilation's totalDuration is adjusted by the delta.
 *
 * Authorization: the caller must be the compilation's author OR an admin.
 *
 * @param {Object} args
 * @param {string} args.tempPath
 * @param {string} args.compilationId
 * @param {string} args.trackId
 * @param {string} args.uploaderUid
 * @param {string} args.callerEmail - lowercased, used for the admin check
 * @returns {Promise<{songId:string, dedupHit:boolean, duration:number|null}>}
 */
export async function replaceTrackSongFromStaging({ tempPath, compilationId, trackId, uploaderUid, callerEmail }) {
  if (!tempPath || !compilationId || !trackId || !uploaderUid) {
    throw new Error('replaceTrackSongFromStaging: missing tempPath/compilationId/trackId/uploaderUid');
  }

  const bucket = getStorage().bucket();
  const db = getFirestore();

  const compRef = db.collection('compilations').doc(compilationId);
  const compSnap = await compRef.get();
  if (!compSnap.exists) {
    throw new Error('Compilation not found.');
  }
  const comp = compSnap.data();
  if (comp.authorUid !== uploaderUid && !(await isAdminEmail(callerEmail))) {
    throw new Error('Only the compilation author or an admin may replace a track.');
  }

  const trackRef = compRef.collection('tracks').doc(trackId);
  const trackSnap = await trackRef.get();
  if (!trackSnap.exists) {
    throw new Error('Track not found.');
  }
  const trackData = trackSnap.data();
  const oldDuration = trackData.duration || 0;

  const stagingFile = bucket.file(tempPath);
  const [stagingBuf] = await stagingFile.download();
  const { songId, songData, dedupHit } = await resolveSongFromBuffer(stagingBuf, uploaderUid);
  const newDuration = songData.duration || 0;

  // Preserve title/artist overrides (user wins). Update songId + duration only.
  await trackRef.set({
    songId,
    duration: newDuration,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  await compRef.set({
    totalDuration: FieldValue.increment(newDuration - oldDuration),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  try { await stagingFile.delete(); } catch (e) { /* ignore */ }

  return { songId, dedupHit, duration: newDuration };
}
