#!/usr/bin/env node
/**
 * Re-stamps the Firebase download token (`firebaseStorageDownloadTokens`) on
 * Storage objects that are missing it. Restoring soft-deleted objects with
 * `gcloud storage restore` brings back the bytes but NOT this Firebase-specific
 * metadata, so the client's getDownloadURL() fails (storage/unknown) and any
 * tokenized URL 412s — even though the file exists. Stamping a token makes
 * getDownloadURL() work again.
 *
 * Runs against PRODUCTION (no emulator). Authenticate first:
 *   gcloud auth application-default login
 *
 * Usage:
 *   node scripts/fix-download-tokens.js                 # report how many lack a token
 *   node scripts/fix-download-tokens.js --fix           # stamp tokens on those missing one
 *   node scripts/fix-download-tokens.js --fix store/     # limit to a prefix
 */
import admin from 'firebase-admin';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const FIX = args.includes('--fix');
const PREFIXES = args.filter((a) => !a.startsWith('--'));
const SCOPES = PREFIXES.length ? PREFIXES : ['store/', 'covers/', 'avatars/'];

const PROJECT = process.env.GCLOUD_PROJECT || 'compilator-83816';
const BUCKET = process.env.STORAGE_BUCKET || `${PROJECT}.appspot.com`;

for (const v of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST']) {
  if (process.env[v]) { console.error(`Refusing to run: ${v} is set (this targets production).`); process.exit(1); }
}

admin.initializeApp({ projectId: PROJECT, storageBucket: BUCKET });
const bucket = admin.storage().bucket();

async function pooledForEach(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  });
  await Promise.all(workers);
}

async function main() {
  console.log(`Project "${PROJECT}", bucket "${BUCKET}" — ${FIX ? 'FIX' : 'report only'}`);
  console.log(`Scopes: ${SCOPES.join(', ')}\n`);

  let total = 0;
  let missing = 0;
  let stamped = 0;
  let failed = 0;

  for (const prefix of SCOPES) {
    const [files] = await bucket.getFiles({ prefix });
    total += files.length;
    const lacking = files.filter((f) => !f.metadata?.metadata?.firebaseStorageDownloadTokens);
    missing += lacking.length;
    console.log(`${prefix}: ${files.length} objects, ${lacking.length} missing a download token`);

    if (FIX && lacking.length) {
      await pooledForEach(lacking, 16, async (file) => {
        try {
          // Merge — only adds the token, preserving contentType / cacheControl.
          await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: randomUUID() } });
          stamped += 1;
        } catch (err) {
          failed += 1;
          console.warn(`  ✗ ${file.name}: ${err.message || err}`);
        }
      });
    }
  }

  console.log(`\nTotal: ${total} objects, ${missing} were missing a token.`);
  if (FIX) console.log(`Stamped ${stamped}; ${failed} failed.`);
  else if (missing) console.log('Re-run with --fix to stamp tokens on them.');
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
