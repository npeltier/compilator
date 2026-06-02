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
 * Hash + parse a buffer, upload the binary to /store/{hash}.mp3 if it isn't
 * already there. Song *documents* are per-compilation now (no global /songs
 * collection); only the binary is deduplicated.
 *
 * @returns {Promise<{hash:string, storagePath:string, metadata:object, common:object, format:object}>}
 */
async function resolveBinaryFromBuffer(buf) {
  const bucket = getStorage().bucket();

  const hash = await computeMp3Hash(buf);
  const metadata = await parseBuffer(buf, 'audio/mpeg');
  const storagePath = getStorePath(hash);

  const file = bucket.file(storagePath);
  const [exists] = await file.exists();
  if (!exists) {
    await file.save(buf, {
      metadata: { contentType: 'audio/mpeg', cacheControl: 'public, max-age=31536000' },
      resumable: false,
    });
  }

  return { hash, storagePath, metadata, dedupHit: exists };
}

/**
 * Process a song already uploaded to a staging path in Cloud Storage.
 * - Resolves the binary in /store/{hash}.mp3 (dedup at the blob level).
 * - Creates /compilations/{compilationId}/songs/{songId} with album=compilationId.
 * - Fills in the compilation cover from ID3 APIC if it doesn't have one yet.
 * - Deletes the staging blob on success.
 */
export async function processSongFromStaging({ tempPath, compilationId, order }) {
  if (!tempPath || !compilationId || order == null) {
    throw new Error('processSongFromStaging: missing tempPath/compilationId/order');
  }

  const bucket = getStorage().bucket();
  const db = getFirestore();

  const stagingFile = bucket.file(tempPath);
  const [stagingBuf] = await stagingFile.download();

  const { hash, storagePath, metadata, dedupHit } = await resolveBinaryFromBuffer(stagingBuf);
  const { duration } = metadata.format || {};
  const { artist, year, title, track, picture } = metadata.common || {};
  const trackNo = track && typeof track.no === 'number' ? track.no : null;

  // Create the per-compilation song doc.
  const compRef = db.collection('compilations').doc(compilationId);
  const songRef = compRef.collection('songs').doc();
  const songData = {
    hash,
    storagePath,
    title: title || null,
    artist: artist || null,
    album: compilationId,
    year: year || null,
    track: trackNo,
    duration: duration || null,
    order,
    addedAt: FieldValue.serverTimestamp(),
  };
  await songRef.set(songData);

  // Refresh denormalized counters on the compilation.
  await compRef.set({
    trackCount: FieldValue.increment(1),
    totalDuration: FieldValue.increment(duration || 0),
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
        metadata: { contentType: pic.format || 'image/jpeg', cacheControl: 'public, max-age=31536000' },
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
    songId: songRef.id,
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
export async function uploadCoverFromStaging({ tempPath, compilationId, ext }) {
  if (!tempPath || !compilationId || !ext) {
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
    metadata: { contentType, cacheControl: 'public, max-age=31536000' },
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
 * Replace the audio binary of an existing song. The song row keeps its order,
 * title, and artist; only hash + storagePath + duration update. Compilation's
 * totalDuration is adjusted by the delta.
 *
 * Authorization: the caller must be the compilation's author (email match) OR
 * an admin.
 */
export async function replaceSongFromStaging({ tempPath, compilationId, songId, callerEmail }) {
  if (!tempPath || !compilationId || !songId || !callerEmail) {
    throw new Error('replaceSongFromStaging: missing tempPath/compilationId/songId/callerEmail');
  }

  const bucket = getStorage().bucket();
  const db = getFirestore();

  const compRef = db.collection('compilations').doc(compilationId);
  const compSnap = await compRef.get();
  if (!compSnap.exists) {
    throw new Error('Compilation not found.');
  }
  const comp = compSnap.data();
  if (comp.author !== callerEmail && !(await isAdminEmail(callerEmail))) {
    throw new Error('Only the compilation author or an admin may replace a song.');
  }

  const songRef = compRef.collection('songs').doc(songId);
  const songSnap = await songRef.get();
  if (!songSnap.exists) {
    throw new Error('Song not found.');
  }
  const oldDuration = songSnap.data().duration || 0;

  const stagingFile = bucket.file(tempPath);
  const [stagingBuf] = await stagingFile.download();
  const { hash, storagePath, metadata, dedupHit } = await resolveBinaryFromBuffer(stagingBuf);
  const newDuration = metadata.format?.duration || 0;

  await songRef.set({
    hash,
    storagePath,
    duration: newDuration,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  await compRef.set({
    totalDuration: FieldValue.increment(newDuration - oldDuration),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  try { await stagingFile.delete(); } catch (e) { /* ignore */ }

  return { dedupHit, duration: newDuration };
}

/**
 * Delete a compilation, its songs subcollection, its cover, and any binaries
 * in /store/ that are no longer referenced by any compilation after the delete.
 *
 * Authorization: the caller must be the compilation's author (email match) OR
 * an admin.
 */
export async function deleteCompilationFully({ compilationId, callerEmail }) {
  if (!compilationId || !callerEmail) {
    throw new Error('deleteCompilationFully: missing arguments');
  }
  const bucket = getStorage().bucket();
  const db = getFirestore();

  const compRef = db.collection('compilations').doc(compilationId);
  const compSnap = await compRef.get();
  if (!compSnap.exists) {
    throw new Error('Compilation not found.');
  }
  const comp = compSnap.data();
  if (comp.author !== callerEmail && !(await isAdminEmail(callerEmail))) {
    throw new Error('Only the compilation author or an admin may delete this compilation.');
  }

  const songsSnap = await compRef.collection('songs').get();
  const hashes = new Set();
  songsSnap.forEach((d) => { if (d.data().hash) hashes.add(d.data().hash); });

  // Delete songs subcollection in bulk.
  if (!songsSnap.empty) {
    const writer = db.bulkWriter();
    songsSnap.forEach((d) => writer.delete(d.ref));
    await writer.close();
  }

  // Delete cover file (best effort).
  if (comp.coverPath) {
    try { await bucket.file(comp.coverPath).delete(); } catch (e) { /* ignore */ }
  }

  // Delete the compilation doc itself.
  await compRef.delete();

  // For each hash this compilation used, check whether any other song doc
  // still references it. If not, delete the binary from /store/.
  let orphansDeleted = 0;
  for (const hash of hashes) {
    const stillUsed = await db.collectionGroup('songs')
      .where('hash', '==', hash)
      .limit(1)
      .get();
    if (stillUsed.empty) {
      try {
        await bucket.file(getStorePath(hash)).delete();
        orphansDeleted += 1;
      } catch (e) { /* ignore */ }
    }
  }

  return { songsDeleted: songsSnap.size, orphansDeleted };
}
