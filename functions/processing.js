import admin from 'firebase-admin';
import { getStorage } from 'firebase-admin/storage';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { parseBuffer } from 'music-metadata';

import { computeMp3Hash, getStorePath } from './hash.js';

if (admin.apps.length === 0) {
  admin.initializeApp();
}

/**
 * Process a song already uploaded to a staging path in Cloud Storage.
 * - Downloads the staging blob.
 * - Computes the audio hash; dedupes against /songs.
 * - If new, copies the blob to /store/{hh}/{hash}.mp3 and writes /songs/{id}.
 * - Always creates /compilations/{compilationId}/tracks/{trackId}.
 * - If the compilation has no cover yet and the song has an embedded APIC,
 *   writes the cover to /covers/{compilationId}.{ext} (coverSource: "id3").
 * - Deletes the staging blob on success.
 *
 * @param {Object} args
 * @param {string} args.tempPath - e.g. "uploads/<uid>/<uuid>.mp3"
 * @param {string} args.compilationId
 * @param {number} args.order
 * @param {string} args.uploaderUid
 * @returns {Promise<{songId:string, trackId:string, dedupHit:boolean, title:string, artist:string, duration:number, coverWritten:boolean}>}
 */
export async function processSongFromStaging({ tempPath, compilationId, order, uploaderUid }) {
  if (!tempPath || !compilationId || order == null || !uploaderUid) {
    throw new Error('processSongFromStaging: missing tempPath/compilationId/order/uploaderUid');
  }

  const bucket = getStorage().bucket();
  const db = getFirestore();

  const stagingFile = bucket.file(tempPath);
  const [stagingBuf] = await stagingFile.download();

  const hash = await computeMp3Hash(stagingBuf);
  const metadata = await parseBuffer(stagingBuf, 'audio/mpeg');
  const { duration } = metadata.format || {};
  const { album, artist, year, title, track, picture } = metadata.common || {};
  const trackNo = track && typeof track.no === 'number' ? track.no : null;

  const songsRef = db.collection('songs');
  const existing = await songsRef.where('hash', '==', hash).limit(1).get();

  let songId;
  let songData;
  let dedupHit = false;

  if (!existing.empty) {
    dedupHit = true;
    const d = existing.docs[0];
    songId = d.id;
    songData = d.data();
  } else {
    const storagePath = getStorePath(hash);
    await bucket.file(storagePath).save(stagingBuf, {
      metadata: { contentType: 'audio/mpeg' },
      resumable: false,
    });

    const songRef = songsRef.doc();
    songId = songRef.id;
    songData = {
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
  }

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
