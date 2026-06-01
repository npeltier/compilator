#!/usr/bin/env node
/**
 * Wipe the emulator's data for the new schema migration:
 *   - Firestore: /users, /compilations (incl. subcollections), /songs (legacy)
 *   - Storage:   /covers/, /store/, /avatars/, /uploads/
 *
 * Keeps /allowlist, /admins, and Auth users intact (they already use the
 * right id strategy and are seeded separately).
 *
 * Run with the emulators already up:
 *   npm run dev      # in another terminal
 *   node scripts/wipe.js
 *   npm run seed     # rebuild /users/{email} for the seed account
 */
import admin from 'firebase-admin';

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099';
process.env.FIREBASE_STORAGE_EMULATOR_HOST ||= '127.0.0.1:9199';

admin.initializeApp({
  projectId: process.env.GCLOUD_PROJECT || 'demo-compilator',
  storageBucket: 'demo-compilator.appspot.com',
});

const db = admin.firestore();
const bucket = admin.storage().bucket();

async function deleteCollection(path) {
  const snap = await db.collection(path).get();
  if (snap.empty) {
    console.log(`  /${path}: already empty`);
    return;
  }
  const writer = db.bulkWriter();
  let count = 0;
  for (const d of snap.docs) {
    // For /compilations, recursively delete subcollections too.
    if (path === 'compilations') {
      const subs = await d.ref.listCollections();
      for (const sub of subs) {
        const subSnap = await sub.get();
        subSnap.forEach((s) => { writer.delete(s.ref); count += 1; });
      }
    }
    // For /users, recursively delete reactions subcollection.
    if (path === 'users') {
      const subs = await d.ref.listCollections();
      for (const sub of subs) {
        const subSnap = await sub.get();
        subSnap.forEach((s) => { writer.delete(s.ref); count += 1; });
      }
    }
    writer.delete(d.ref);
    count += 1;
  }
  await writer.close();
  console.log(`  /${path}: deleted ${count} doc(s)`);
}

async function deleteStoragePrefix(prefix) {
  const [files] = await bucket.getFiles({ prefix });
  if (files.length === 0) {
    console.log(`  ${prefix}: already empty`);
    return;
  }
  await Promise.all(files.map((f) => f.delete().catch(() => {})));
  console.log(`  ${prefix}: deleted ${files.length} file(s)`);
}

async function main() {
  console.log('Wiping Firestore collections:');
  await deleteCollection('users');
  await deleteCollection('compilations');
  await deleteCollection('songs'); // legacy top-level, post-migration should be empty

  console.log('\nWiping Storage prefixes:');
  await deleteStoragePrefix('covers/');
  await deleteStoragePrefix('store/');
  await deleteStoragePrefix('avatars/');
  await deleteStoragePrefix('uploads/');

  console.log('\nDone. Next: npm run seed (recreates /users/peltier.nicolas@gmail.com).');
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
