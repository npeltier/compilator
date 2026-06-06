#!/usr/bin/env node
/**
 * Compress and optimize all covers in Firebase Storage.
 *   - Resizes to max 800×800 px (preserving aspect ratio, no upscale)
 *   - Re-encodes as progressive JPEG at quality 80
 *   - Sets Cache-Control: public, max-age=31536000
 *   - Skips files already at or below MIN_SAVINGS_RATIO improvement
 *
 * Usage (production):
 *   node scripts/optimize-covers.js
 *
 * Requires application default credentials or GOOGLE_APPLICATION_CREDENTIALS env var:
 *   gcloud auth application-default login
 *   # or
 *   GOOGLE_APPLICATION_CREDENTIALS=./service-account-key.json node scripts/optimize-covers.js
 */

import admin from 'firebase-admin';
import { getStorage } from 'firebase-admin/storage';
import sharp from 'sharp';
import { readFileSync } from 'fs';

const PROJECT = process.env.GCLOUD_PROJECT
  || JSON.parse(readFileSync(new URL('../.firebaserc', import.meta.url))).projects.default;
const BUCKET = process.env.FIREBASE_STORAGE_BUCKET || `${PROJECT}.appspot.com`;

const MAX_PX = 800;
const JPEG_QUALITY = 80;
const CACHE_CONTROL = 'public, max-age=31536000';
const MIN_SAVINGS_RATIO = 0.05;

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: PROJECT, storageBucket: BUCKET });
}
const bucket = getStorage().bucket();

async function run() {
  const [files] = await bucket.getFiles({ prefix: 'covers/' });
  const covers = files.filter((f) => !f.name.endsWith('/'));
  console.log(`Found ${covers.length} cover(s) in gs://${BUCKET}/covers/\n`);

  let compressed = 0;
  let cacheOnly = 0;
  let skipped = 0;
  let errors = 0;

  for (const file of covers) {
    const name = file.name;
    try {
      const [meta] = await file.getMetadata();
      const originalSize = parseInt(meta.size, 10);

      const [buf] = await file.download();
      const optimized = await sharp(buf)
        .resize({ width: MAX_PX, height: MAX_PX, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: JPEG_QUALITY, progressive: true })
        .toBuffer();

      const savings = (originalSize - optimized.length) / originalSize;

      if (savings < MIN_SAVINGS_RATIO) {
        if (meta.cacheControl !== CACHE_CONTROL) {
          await file.setMetadata({ cacheControl: CACHE_CONTROL });
          console.log(`[cache] ${name}  ${kb(originalSize)} — set cache header`);
          cacheOnly++;
        } else {
          console.log(`[skip] ${name}  ${kb(originalSize)} — already optimal`);
          skipped++;
        }
        continue;
      }

      await file.save(optimized, {
        metadata: { contentType: 'image/jpeg', cacheControl: CACHE_CONTROL },
        resumable: false,
      });

      console.log(`[ok]   ${name}  ${kb(originalSize)} → ${kb(optimized.length)}  (${pct(savings)} saved)`);
      compressed++;
    } catch (err) {
      console.error(`[err]  ${name}: ${err.message}`);
      errors++;
    }
  }

  console.log(`\n${compressed} compressed, ${cacheOnly} cache-only, ${skipped} skipped, ${errors} errors.`);
}

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const pct = (r) => `${(r * 100).toFixed(1)}%`;

run().catch((err) => { console.error(err); process.exit(1); });
