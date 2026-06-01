// End-to-end integration test that exercises the real upload pipeline against
// the running Firebase Emulator Suite. Replicates exactly what the browser does:
// signs in via Auth, uploads MP3s + cover directly to Storage staging, then
// calls the processSong / uploadCover callables. Reads the compilation back
// from Firestore and downloads a song blob to confirm it can be "listened to".
//
// Prerequisites:
//   - Emulator suite running on localhost (npm run dev)
//   - Seeded admin user (npm run seed) — peltier.nicolas@gmail.com / password
//   - ffmpeg on PATH
//
// Run with:  npm run test:e2e

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { initializeApp } from 'firebase/app';
import {
  getAuth, connectAuthEmulator, signInWithEmailAndPassword,
} from 'firebase/auth';
import {
  getFirestore, connectFirestoreEmulator, collection, addDoc, doc, getDoc,
  getDocs, query, orderBy, where, serverTimestamp, updateDoc, deleteDoc,
} from 'firebase/firestore';
import {
  getStorage, connectStorageEmulator, ref as sref, uploadBytes, getBytes,
} from 'firebase/storage';
import {
  getFunctions, connectFunctionsEmulator, httpsCallable,
} from 'firebase/functions';

import { buildAlbum } from './fixtures.mjs';

const EMAIL = 'peltier.nicolas@gmail.com';
const PASSWORD = 'password';

const app = initializeApp({
  apiKey: 'demo', projectId: 'demo-compilator',
  storageBucket: 'demo-compilator.appspot.com', appId: 'demo',
});
const auth = getAuth(app); connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
const db = getFirestore(app); connectFirestoreEmulator(db, '127.0.0.1', 8080);
const storage = getStorage(app); connectStorageEmulator(storage, '127.0.0.1', 9199);
const functions = getFunctions(app); connectFunctionsEmulator(functions, '127.0.0.1', 5001);

function step(label) { console.log(`\n→ ${label}`); }
function ok(msg) { console.log(`  ✓ ${msg}`); }

const t0 = Date.now();

step('sign in as the seeded user');
const cred = await signInWithEmailAndPassword(auth, EMAIL, PASSWORD);
ok(`uid = ${cred.user.uid}, email = ${cred.user.email}`);

step('build fixtures (3 MP3s + cover) via ffmpeg');
const album = buildAlbum();
ok(`tracks: ${album.tracks.map(t => basename(t.path)).join(', ')}`);
ok(`cover: ${basename(album.cover)}`);

step('remove any prior smoke compilation (idempotent re-run)');
const SMOKE_TITLE = 'Smoke Test E2E';
const prior = await getDocs(query(
  collection(db, 'compilations'),
  where('author', '==', EMAIL),
  where('title', '==', SMOKE_TITLE),
));
for (const d of prior.docs) {
  const ss = await getDocs(collection(db, 'compilations', d.id, 'songs'));
  await Promise.all(ss.docs.map(s => deleteDoc(s.ref)));
  await deleteDoc(d.ref);
}
ok(`removed ${prior.size} prior smoke compilation(s)`);

step('create draft compilation in Firestore');
const compRef = await addDoc(collection(db, 'compilations'), {
  title: SMOKE_TITLE,
  season: 'ete', year: 2099,  // future slot, no collision with the user's real "prochaine compil"
  author: EMAIL,
  coverPath: null, coverSource: null, status: 'draft',
  trackCount: 0, totalDuration: 0,
  createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
});
ok(`compilation id = ${compRef.id}`);

step('upload cover via staging + callable');
const coverBuf = readFileSync(album.cover);
const coverTemp = `uploads/${cred.user.uid}/cover-${Date.now()}.png`;
await uploadBytes(sref(storage, coverTemp), coverBuf, { contentType: 'image/png' });
const uploadCoverFn = httpsCallable(functions, 'uploadCover');
const coverResult = await uploadCoverFn({ tempPath: coverTemp, compilationId: compRef.id, ext: 'png' });
ok(`coverPath = ${coverResult.data.coverPath}`);

step('upload each MP3 via staging + callable');
const processSongFn = httpsCallable(functions, 'processSong');
const songResults = [];
for (let i = 0; i < album.tracks.length; i++) {
  const t = album.tracks[i];
  const buf = readFileSync(t.path);
  const temp = `uploads/${cred.user.uid}/song-${Date.now()}-${i}.mp3`;
  await uploadBytes(sref(storage, temp), buf, { contentType: 'audio/mpeg' });
  const res = await processSongFn({ tempPath: temp, compilationId: compRef.id, order: i });
  songResults.push(res.data);
  ok(`song ${i + 1}: songId=${res.data.songId} dedupHit=${res.data.dedupHit} title="${res.data.title}"`);
}

step('verify compilation document is correctly populated');
const compSnap = await getDoc(compRef);
const comp = compSnap.data();
assert.equal(comp.trackCount, 3, `expected trackCount=3, got ${comp.trackCount}`);
assert.equal(comp.author, EMAIL, `expected author=${EMAIL}, got ${comp.author}`);
assert.ok(!comp.authorName, 'authorName field should be absent in the new schema');
assert.ok(comp.coverPath?.startsWith('covers/'), `expected coverPath to start with covers/, got ${comp.coverPath}`);
assert.equal(comp.coverSource, 'upload', `expected coverSource=upload, got ${comp.coverSource}`);
assert.ok(comp.totalDuration > 0, `expected totalDuration > 0, got ${comp.totalDuration}`);
ok(`trackCount=${comp.trackCount}, author=${comp.author}, totalDuration=${comp.totalDuration.toFixed(2)}s`);

step('verify the songs subcollection has 3 ordered entries, each with album=compId');
const songsSnap = await getDocs(query(collection(db, 'compilations', compRef.id, 'songs'), orderBy('order', 'asc')));
assert.equal(songsSnap.size, 3, `expected 3 songs, got ${songsSnap.size}`);
const songDocs = songsSnap.docs.map(d => d.data());
assert.deepEqual(songDocs.map(s => s.order), [0, 1, 2]);
for (const s of songDocs) {
  assert.equal(s.album, compRef.id, `expected album=${compRef.id}, got ${s.album}`);
  assert.ok(s.hash && s.hash.length === 64, `bad hash: ${s.hash}`);
  assert.ok(s.storagePath?.startsWith('store/'), `bad storagePath: ${s.storagePath}`);
  assert.ok(!('uploaderUid' in s), 'uploaderUid should be absent in the new schema');
}
ok('order = [0, 1, 2], all songs have album=compId, no uploaderUid');

step('"listen" — fetch a song blob from the canonical store');
const firstSong = songDocs[0];
const bytes = await getBytes(sref(storage, firstSong.storagePath));
assert.ok(bytes.byteLength > 0, 'downloaded an empty file');
ok(`downloaded ${bytes.byteLength} bytes from ${firstSong.storagePath}`);

step('verify dedup: re-upload the same MP3 into a throwaway compilation, expect dedupHit=true');
const dedupComp = await addDoc(collection(db, 'compilations'), {
  title: 'Smoke Test — dedup probe', season: 'ete', year: 2099,
  author: EMAIL,
  coverPath: null, coverSource: null, status: 'draft',
  trackCount: 0, totalDuration: 0,
  createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
});
const buf = readFileSync(album.tracks[0].path);
const temp = `uploads/${cred.user.uid}/dedup-${Date.now()}.mp3`;
await uploadBytes(sref(storage, temp), buf, { contentType: 'audio/mpeg' });
const dedupRes = await processSongFn({ tempPath: temp, compilationId: dedupComp.id, order: 0 });
assert.equal(dedupRes.data.dedupHit, true, 'second upload should be a dedup hit at the binary level');
// Song doc is per-compilation, so the IDs differ even on dedup hit.
assert.notEqual(dedupRes.data.songId, songResults[0].songId, 'song doc id should be per-compilation');
const dedupSongs = await getDocs(collection(db, 'compilations', dedupComp.id, 'songs'));
const dedupSongData = dedupSongs.docs[0].data();
assert.equal(dedupSongData.hash, firstSong.hash, 'hash should match the first compilation');
assert.equal(dedupSongData.album, dedupComp.id, 'album should be the dedup probe compilation id');

step('deleteCompilation removes the dedup probe but preserves the shared binary');
const deleteCompFn = httpsCallable(functions, 'deleteCompilation');
const delRes = await deleteCompFn({ compilationId: dedupComp.id });
ok(`deleted ${delRes.data.songsDeleted} song(s), ${delRes.data.orphansDeleted} orphan binary(ies)`);
const dedupSnapAfter = await getDoc(dedupComp);
assert.ok(!dedupSnapAfter.exists(), 'compilation doc should be gone');
assert.equal(delRes.data.orphansDeleted, 0, 'binary is still referenced by the main smoke compilation');
// Binary still downloadable from the main compilation.
const stillBytes = await getBytes(sref(storage, firstSong.storagePath));
assert.ok(stillBytes.byteLength > 0, 'shared binary should still exist in /store/');
ok('shared binary preserved, dedup probe fully removed');

step('publish the compilation (kept in emulator for manual browsing)');
await updateDoc(compRef, { status: 'published' });
ok(`browse at http://localhost:5050/c/${compRef.id}`);

console.log(`\n✅ all checks passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(0);
