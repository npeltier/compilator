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
ok(`uid = ${cred.user.uid}`);

step('build fixtures (3 MP3s + cover) via ffmpeg');
const album = buildAlbum();
ok(`tracks: ${album.tracks.map(t => basename(t.path)).join(', ')}`);
ok(`cover: ${basename(album.cover)}`);

step('remove any prior smoke compilation (idempotent re-run)');
const SMOKE_TITLE = 'Smoke Test E2E';
const prior = await getDocs(query(
  collection(db, 'compilations'),
  where('authorUid', '==', cred.user.uid),
  where('title', '==', SMOKE_TITLE),
));
for (const d of prior.docs) {
  const ts = await getDocs(collection(db, 'compilations', d.id, 'tracks'));
  await Promise.all(ts.docs.map(t => deleteDoc(t.ref)));
  await deleteDoc(d.ref);
}
ok(`removed ${prior.size} prior smoke compilation(s)`);

step('create draft compilation in Firestore');
const compRef = await addDoc(collection(db, 'compilations'), {
  title: SMOKE_TITLE,
  season: 'ete', year: 2099,  // future slot, no collision with the user's real "prochaine compil"
  authorUid: cred.user.uid, authorName: 'Nicolas P.',
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
  ok(`track ${i + 1}: songId=${res.data.songId} dedupHit=${res.data.dedupHit} title="${res.data.title}"`);
}

step('verify compilation document is correctly populated');
const compSnap = await getDoc(compRef);
const comp = compSnap.data();
assert.equal(comp.trackCount, 3, `expected trackCount=3, got ${comp.trackCount}`);
assert.ok(comp.coverPath?.startsWith('covers/'), `expected coverPath to start with covers/, got ${comp.coverPath}`);
assert.equal(comp.coverSource, 'upload', `expected coverSource=upload, got ${comp.coverSource}`);
assert.ok(comp.totalDuration > 0, `expected totalDuration > 0, got ${comp.totalDuration}`);
ok(`trackCount=${comp.trackCount}, totalDuration=${comp.totalDuration.toFixed(2)}s, coverSource=${comp.coverSource}`);

step('verify the tracks subcollection has 3 ordered entries');
const tracksSnap = await getDocs(query(collection(db, 'compilations', compRef.id, 'tracks'), orderBy('order', 'asc')));
assert.equal(tracksSnap.size, 3, `expected 3 tracks, got ${tracksSnap.size}`);
const trackDocs = tracksSnap.docs.map(d => d.data());
assert.deepEqual(trackDocs.map(t => t.order), [0, 1, 2]);
ok('order = [0, 1, 2]');

step('verify each /songs doc exists with metadata');
for (const r of songResults) {
  const songSnap = await getDoc(doc(db, 'songs', r.songId));
  assert.ok(songSnap.exists(), `song ${r.songId} missing`);
  const s = songSnap.data();
  assert.ok(s.hash && s.hash.length === 64, `bad hash for ${r.songId}: ${s.hash}`);
  assert.ok(s.storagePath?.startsWith('store/'), `bad storagePath for ${r.songId}: ${s.storagePath}`);
}
ok('all 3 song docs valid');

step('"listen" — fetch a song blob from the canonical store');
const firstSong = (await getDoc(doc(db, 'songs', songResults[0].songId))).data();
const bytes = await getBytes(sref(storage, firstSong.storagePath));
assert.ok(bytes.byteLength > 0, 'downloaded an empty file');
ok(`downloaded ${bytes.byteLength} bytes from ${firstSong.storagePath}`);

step('verify dedup: re-upload the same MP3 into a throwaway compilation, expect dedupHit=true');
const dedupComp = await addDoc(collection(db, 'compilations'), {
  title: 'Smoke Test — dedup probe', season: 'ete', year: 2099,
  authorUid: cred.user.uid, authorName: 'Nicolas P.',
  coverPath: null, coverSource: null, status: 'draft',
  trackCount: 0, totalDuration: 0,
  createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
});
const buf = readFileSync(album.tracks[0].path);
const temp = `uploads/${cred.user.uid}/dedup-${Date.now()}.mp3`;
await uploadBytes(sref(storage, temp), buf, { contentType: 'audio/mpeg' });
const dedupRes = await processSongFn({ tempPath: temp, compilationId: dedupComp.id, order: 0 });
assert.equal(dedupRes.data.dedupHit, true, 'second upload should be a dedup hit');
assert.equal(dedupRes.data.songId, songResults[0].songId, 'should reuse the first song id');
const dedupTracks = await getDocs(collection(db, 'compilations', dedupComp.id, 'tracks'));
await Promise.all(dedupTracks.docs.map(d => deleteDoc(d.ref)));
await deleteDoc(dedupComp);
ok('dedup confirmed, probe compilation removed');

step('publish the compilation (kept in emulator for manual browsing)');
await updateDoc(compRef, { status: 'published' });
ok(`browse at http://localhost:5050/compilation.html?id=${compRef.id}`);

console.log(`\n✅ all checks passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(0);
