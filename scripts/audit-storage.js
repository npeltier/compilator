#!/usr/bin/env node
/**
 * Audits PRODUCTION Firestore for dangling Storage references — docs that point
 * at a Storage object that no longer exists (the cause of avatar / audio 404s):
 *   - /users/{email}.avatarPath        → avatars/{email}.jpg
 *   - /compilations/{id}/songs/*.storagePath → store/xx/<hash>.mp3
 *
 * Report-only by default. Pass --fix to null out dangling avatarPaths so the UI
 * cleanly falls back to the initial (songs are only reported — a missing binary
 * means the track needs re-uploading, which this script can't do).
 *
 * Runs against the REAL project (no emulator). Authenticate first with either:
 *   gcloud auth application-default login         # uses your ADC
 *   # or set GOOGLE_APPLICATION_CREDENTIALS to a service-account key
 *
 * Usage:
 *   node scripts/audit-storage.js            # report
 *   node scripts/audit-storage.js --fix      # report + clear dangling avatarPaths
 */
import admin from 'firebase-admin';

const FIX = process.argv.includes('--fix');
const PROJECT = process.env.GCLOUD_PROJECT || 'compilator-83816';
const BUCKET = process.env.STORAGE_BUCKET || `${PROJECT}.appspot.com`;

// Guard: refuse to run if emulator env vars are set — this must hit prod.
for (const v of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST']) {
  if (process.env[v]) {
    console.error(`Refusing to run: ${v} is set. This script audits production, not the emulator.`);
    process.exit(1);
  }
}

admin.initializeApp({ projectId: PROJECT, storageBucket: BUCKET });
const db = admin.firestore();
const bucket = admin.storage().bucket();
const { FieldValue } = admin.firestore;

// Resolve exists() for many paths with light concurrency.
async function existsMap(paths) {
  const out = new Map();
  const unique = [...new Set(paths)];
  const POOL = 16;
  for (let i = 0; i < unique.length; i += POOL) {
    const slice = unique.slice(i, i + POOL);
    const results = await Promise.all(slice.map((p) => bucket.file(p).exists().then(([e]) => e).catch(() => false)));
    slice.forEach((p, j) => out.set(p, results[j]));
  }
  return out;
}

async function main() {
  console.log(`Auditing project "${PROJECT}", bucket "${BUCKET}" — ${FIX ? 'FIX' : 'report only'}\n`);

  // ---- Avatars ----
  const usersSnap = await db.collection('users').get();
  const userAvatars = [];
  usersSnap.forEach((d) => {
    const p = d.data().avatarPath;
    if (p) userAvatars.push({ id: d.id, ref: d.ref, path: p });
  });
  const avatarExists = await existsMap(userAvatars.map((u) => u.path));
  const danglingAvatars = userAvatars.filter((u) => !avatarExists.get(u.path));

  console.log(`Avatars: ${userAvatars.length} referenced, ${danglingAvatars.length} dangling`);
  danglingAvatars.forEach((u) => console.log(`  ✗ ${u.id} → ${u.path}`));

  // ---- Song binaries ----
  const songsSnap = await db.collectionGroup('songs').get();
  const songs = [];
  songsSnap.forEach((d) => {
    const p = d.data().storagePath;
    const compId = d.ref.parent.parent?.id;
    if (p) songs.push({ compId, songId: d.id, title: d.data().title || '', path: p });
  });
  const songExists = await existsMap(songs.map((s) => s.path));
  const danglingSongs = songs.filter((s) => !songExists.get(s.path));

  console.log(`\nSongs: ${songs.length} referenced, ${danglingSongs.length} dangling`);
  danglingSongs.forEach((s) => console.log(`  ✗ ${s.compId}/${s.songId} "${s.title}" → ${s.path}`));

  // ---- Fix (avatars only) ----
  if (FIX && danglingAvatars.length) {
    console.log(`\nClearing ${danglingAvatars.length} dangling avatarPath(s)…`);
    const batch = db.batch();
    danglingAvatars.forEach((u) => batch.update(u.ref, { avatarPath: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() }));
    await batch.commit();
    console.log('Done — those users now fall back to their initial.');
  } else if (!FIX && danglingAvatars.length) {
    console.log('\nRe-run with --fix to clear the dangling avatarPaths above.');
  }
  if (danglingSongs.length) {
    console.log('\nDangling songs need their audio re-uploaded (compilation edit → "Remplacer l\'audio"); this script does not delete song docs.');
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
