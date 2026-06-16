// Exports the Firestore /users collection to scripts/users_export.json.
//
// Uses Application Default Credentials (same as audit-storage.js / fix-download-tokens.js)
// — no service-account key file needed. Authenticate once with:
//   gcloud auth application-default login
//
// Targets the real project by default; override with GCLOUD_PROJECT, or point at
// the emulator by setting FIRESTORE_EMULATOR_HOST=127.0.0.1:8080.
//
// Usage:  node scripts/export-users.js

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = process.env.GCLOUD_PROJECT || 'compilator-83816';

initializeApp({ credential: applicationDefault(), projectId: PROJECT });
const db = getFirestore();

async function exportUsers() {
  console.log(`Fetching /users from project "${PROJECT}"${process.env.FIRESTORE_EMULATOR_HOST ? ' (emulator)' : ''}…`);
  const snapshot = await db.collection('users').get();

  if (snapshot.empty) {
    console.log('No user documents found.');
    return;
  }

  const users = snapshot.docs.map((doc) => ({ email: doc.id, ...doc.data() }));

  const outputPath = join(__dirname, 'users_export.json');
  writeFileSync(outputPath, JSON.stringify(users, null, 2), 'utf-8');
  console.log(`Success! Exported ${users.length} users to ${outputPath}`);
}

exportUsers().then(() => process.exit(0)).catch((err) => {
  console.error('Error exporting users:', err);
  process.exit(1);
});
