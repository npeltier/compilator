import admin from 'firebase-admin';
import { getStorage } from 'firebase-admin/storage';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { parseBuffer } from 'music-metadata';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffmpeg from 'fluent-ffmpeg';
import { Readable } from 'stream';
import { readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

import { computeMp3Hash, getStorePath } from './hash.js';
import { isAdminEmail } from './auth.js';
import { findAndUpdateDoublons } from './doublons.js';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

if (admin.apps.length === 0) {
  admin.initializeApp();
}

// Bumped whenever the duration/transcode pipeline changes in a way that
// invalidates previously stored values. Songs carry their pipeline version in
// `durationFixV`; the recompute re-checks anything below the current version.
export const DURATION_FIX_VERSION = 1;

// Run ffmpeg from an input buffer to a *seekable temp file*, then return the
// bytes. The output MUST be a real file, not a pipe: with a non-seekable stream
// ffmpeg can't rewind to write the VBR/Xing header, which leaves the MP3 with a
// bogus duration (e.g. a 9:38 track reported as 55:19). Writing to disk lets it
// finalize the header correctly.
async function ffmpegToTempMp3(inputBuf, configure) {
  const out = join(tmpdir(), `mp3-${randomUUID()}.mp3`);
  try {
    await new Promise((resolve, reject) => {
      const cmd = ffmpeg(Readable.from(inputBuf)).noVideo().format('mp3');
      configure(cmd);
      cmd.on('error', reject).on('end', resolve).save(out);
    });
    return await readFile(out);
  } finally {
    await unlink(out).catch(() => {});
  }
}

async function transcodeToMp3(buf) {
  const probe = await parseBuffer(buf);
  if (probe.format.container === 'MPEG') return buf;
  return ffmpegToTempMp3(buf, (cmd) => cmd.audioCodec('libmp3lame').audioQuality(2));
}

// Losslessly re-mux an MP3 (copy the audio frames, rewrite a correct header) to
// repair files an older pipe-based transcode left with a broken/missing VBR
// header. Returns the repaired bytes.
async function remuxMp3(buf) {
  return ffmpegToTempMp3(buf, (cmd) => cmd.audioCodec('copy'));
}

/**
 * Hash + parse a buffer, upload the binary to /store/{hash}.mp3 if it isn't
 * already there. Song *documents* are per-compilation now (no global /songs
 * collection); only the binary is deduplicated.
 *
 * @returns {Promise<{hash:string, storagePath:string, metadata:object, common:object, format:object}>}
 */
async function resolveBinaryFromBuffer(buf) {
  buf = await transcodeToMp3(buf);
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
    durationFixV: DURATION_FIX_VERSION,
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

  // Compute and store doublon references (best-effort).
  try {
    await findAndUpdateDoublons(db, compilationId, songRef.id, hash, songData.artist);
  } catch (e) {
    console.warn('findAndUpdateDoublons failed (non-fatal):', e);
  }

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
 * Repair stored song durations in place. An older transcode wrote MP3s through a
 * non-seekable pipe, leaving a broken VBR header that reports a bogus duration
 * (e.g. a 9:38 track measured as 55:19) — the bad value is baked into the file,
 * so re-parsing alone can't fix it. For each song we download the binary, re-mux
 * it (lossless: copies the audio, rewrites a correct header), re-measure, and —
 * if the duration was wrong — overwrite the stored file with the repaired one so
 * playback/seeking work too. The song doc + the compilation's totalDuration are
 * then corrected.
 *
 * Each song carries a `durationFixV` pipeline version once processed, so this
 * only pays the (expensive) download+remux until that matches the current
 * version. Pass `force` to re-check everything regardless.
 *
 * @returns {Promise<{songCount, checked, fixed, totalDuration, durations}>}
 */
export async function recomputeDurationsFromStore({ compilationId, force = false }) {
  if (!compilationId) {
    throw new Error('recomputeDurationsFromStore: missing compilationId');
  }
  const bucket = getStorage().bucket();
  const db = getFirestore();
  const compRef = db.collection('compilations').doc(compilationId);
  const songsSnap = await compRef.collection('songs').get();

  let total = 0;
  let checked = 0;
  let fixed = 0;
  const durations = {}; // songId -> duration, so the client can refresh its UI
  const writer = db.bulkWriter();

  for (const d of songsSnap.docs) {
    const s = d.data();
    let duration = s.duration || 0;
    const needsCheck = (force || s.durationFixV !== DURATION_FIX_VERSION) && s.storagePath;
    if (needsCheck) {
      checked += 1;
      try {
        const file = bucket.file(s.storagePath);
        const [buf] = await file.download();
        // Re-mux to rewrite a correct header, then measure the repaired bytes.
        const repaired = await remuxMp3(buf);
        const meta = await parseBuffer(repaired, 'audio/mpeg', { duration: true });
        const probed = meta.format?.duration || 0;
        if (probed > 0) {
          const wasWrong = Math.abs(probed - (s.duration || 0)) > 1;
          if (wasWrong) {
            fixed += 1;
            // The stored file's header was broken — replace it with the repaired
            // copy so the player's duration/seek bar is correct as well.
            if (repaired.length) {
              await file.save(repaired, {
                metadata: { contentType: 'audio/mpeg', cacheControl: 'public, max-age=31536000' },
                resumable: false,
              });
            }
          }
          duration = probed;
          writer.set(d.ref, {
            duration,
            durationFixV: DURATION_FIX_VERSION,
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
        }
        // probed === 0 → leave duration + version untouched so it retries later.
      } catch (e) {
        console.warn('recomputeDurations: failed for song', d.id, e.message);
      }
    }
    durations[d.id] = duration;
    total += duration;
  }

  await writer.close();
  await compRef.set({
    totalDuration: total,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  return { songCount: songsSnap.size, checked, fixed, totalDuration: total, durations };
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
    durationFixV: DURATION_FIX_VERSION,
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
