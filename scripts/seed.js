#!/usr/bin/env node
/**
 * Seeds the local Firebase emulators with baseline data:
 *   - one allowlist entry (default: peltier.nicolas@gmail.com, override with $SEED_EMAIL)
 *   - a corresponding Auth user (password "password")
 *
 * Run with the emulators already running:
 *   npm run dev          # in another terminal
 *   npm run seed
 */
import admin from 'firebase-admin';

const SEED_EMAIL = (process.env.SEED_EMAIL || 'peltier.nicolas@gmail.com').toLowerCase();
const SEED_PASSWORD = process.env.SEED_PASSWORD || 'password';
const SEED_DISPLAY_NAME = process.env.SEED_DISPLAY_NAME || 'Nicolas P.';

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099';
process.env.FIREBASE_STORAGE_EMULATOR_HOST ||= '127.0.0.1:9199';

admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-compilator' });

const db = admin.firestore();
const auth = admin.auth();

async function ensureUser() {
  try {
    const existing = await auth.getUserByEmail(SEED_EMAIL);
    console.log(`Auth user already exists: ${SEED_EMAIL} (${existing.uid})`);
    return existing;
  } catch (err) {
    if (err.code !== 'auth/user-not-found') throw err;
    const created = await auth.createUser({
      email: SEED_EMAIL,
      password: SEED_PASSWORD,
      displayName: SEED_DISPLAY_NAME,
      emailVerified: true,
    });
    console.log(`Created auth user: ${SEED_EMAIL} (${created.uid})`);
    return created;
  }
}

async function main() {
  await db.collection('allowlist').doc(SEED_EMAIL).set({
    addedBy: 'seed-script',
    addedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`Allowlisted ${SEED_EMAIL}`);

  const user = await ensureUser();

  await db.collection('users').doc(user.uid).set({
    email: SEED_EMAIL,
    displayName: SEED_DISPLAY_NAME,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  console.log(`Wrote /users/${user.uid}`);

  console.log('\nDone. Sign in at http://localhost:5050/login.html with:');
  console.log(`  email:    ${SEED_EMAIL}`);
  console.log(`  password: ${SEED_PASSWORD}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
