// Shared upload pipeline: takes a File (or Blob), uploads it to a
// staging path in Cloud Storage, then calls the processSong callable to dedupe,
// move to the canonical store, and append it to the compilation as a track.
//
// Used by both upload.html (fancy single-compilation upload) and migrate.html
// (bulk legacy ZIP import).

import { auth, storage, functions } from './firebase-init.js';
import {
  ref as storageRef,
  uploadBytesResumable,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-storage.js';
import {
  httpsCallable,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js';

const processSongFn = httpsCallable(functions, 'processSong');
const uploadCoverFn = httpsCallable(functions, 'uploadCover');
const replaceSongFn = httpsCallable(functions, 'replaceSong');
const deleteCompilationFn = httpsCallable(functions, 'deleteCompilation');

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Upload one MP3 (File or Blob) into staging, then call processSong.
 * Reports upload progress via `onProgress(fraction)`.
 *
 * @returns {Promise<{songId,trackId,dedupHit,title,artist,duration}>}
 */
export async function uploadSong({ file, compilationId, order, onProgress, filename }) {
  const user = auth.currentUser;
  if (!user) throw new Error('Non connecté.');
  const id = uuid();
  const safeName = (filename || file.name || 'track.mp3').replace(/[^a-zA-Z0-9._-]/g, '_');
  const tempPath = `uploads/${user.uid}/${id}-${safeName}`;

  const task = uploadBytesResumable(storageRef(storage, tempPath), file, {
    contentType: 'audio/mpeg',
  });

  await new Promise((resolve, reject) => {
    task.on('state_changed',
      (snap) => onProgress?.(snap.bytesTransferred / Math.max(1, snap.totalBytes)),
      reject,
      resolve,
    );
  });

  const { data } = await processSongFn({ tempPath, compilationId, order });
  return data;
}

/**
 * Upload a cover image into staging, then call uploadCover.
 */
export async function uploadCover({ file, compilationId, onProgress }) {
  const user = auth.currentUser;
  if (!user) throw new Error('Non connecté.');
  const ext = (file.name?.split('.').pop() || 'jpg').toLowerCase();
  const id = uuid();
  const tempPath = `uploads/${user.uid}/cover-${id}.${ext}`;
  const task = uploadBytesResumable(storageRef(storage, tempPath), file, {
    contentType: file.type || (ext === 'png' ? 'image/png' : 'image/jpeg'),
  });
  await new Promise((resolve, reject) => {
    task.on('state_changed',
      (snap) => onProgress?.(snap.bytesTransferred / Math.max(1, snap.totalBytes)),
      reject,
      resolve,
    );
  });
  const { data } = await uploadCoverFn({ tempPath, compilationId, ext });
  return data;
}

/**
 * Replace an existing song's audio binary. Uploads the new file to staging,
 * then calls the replaceSong callable which re-hashes the binary and updates
 * the song row's hash/storagePath/duration. Title/artist are preserved.
 *
 * @returns {Promise<{dedupHit,duration}>}
 */
export async function replaceSongBinary({ file, compilationId, songId, onProgress, filename }) {
  const user = auth.currentUser;
  if (!user) throw new Error('Non connecté.');
  const id = uuid();
  const safeName = (filename || file.name || 'track.mp3').replace(/[^a-zA-Z0-9._-]/g, '_');
  const tempPath = `uploads/${user.uid}/${id}-${safeName}`;

  const task = uploadBytesResumable(storageRef(storage, tempPath), file, {
    contentType: 'audio/mpeg',
  });
  await new Promise((resolve, reject) => {
    task.on('state_changed',
      (snap) => onProgress?.(snap.bytesTransferred / Math.max(1, snap.totalBytes)),
      reject,
      resolve,
    );
  });

  const { data } = await replaceSongFn({ tempPath, compilationId, songId });
  return data;
}

/**
 * Delete a compilation — its doc, its songs subcollection, its cover, and any
 * /store/ binaries no longer referenced elsewhere. Runs server-side via the
 * deleteCompilation callable for atomicity.
 *
 * @returns {Promise<{songsDeleted, orphansDeleted}>}
 */
export async function deleteCompilation(compilationId) {
  const { data } = await deleteCompilationFn({ compilationId });
  return data;
}

/**
 * Run upload tasks with a concurrency cap. `tasks` is an array of async functions.
 */
export async function runWithConcurrency(tasks, limit = 3) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      try {
        results[i] = { ok: true, value: await tasks[i]() };
      } catch (err) {
        results[i] = { ok: false, error: err };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}
