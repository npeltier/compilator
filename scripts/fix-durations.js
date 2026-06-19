#!/usr/bin/env node
/**
 * Repair song durations that an older, pipe-based transcode stored incorrectly
 * (e.g. a 9:38 track saved as 55:19). The bad value is baked into the stored
 * MP3's header, so for every compilation this re-muxes each binary to rewrite a
 * valid header, re-measures the duration, overwrites the stored file when it was
 * wrong (so playback/seeking are correct too), and fixes the song doc + the
 * compilation's totalDuration.
 *
 * Idempotent: songs already at the current pipeline version are skipped, so it's
 * safe to re-run. Pass --force to re-process every song regardless.
 *
 * Runs against the REAL project (no emulator). Authenticate first with either:
 *   gcloud auth application-default login          # uses your ADC
 *   # or set GOOGLE_APPLICATION_CREDENTIALS to a service-account key
 *
 * Usage:
 *   node scripts/fix-durations.js            # repair all compilations
 *   node scripts/fix-durations.js --force    # re-check even already-fixed songs
 */
import admin from 'firebase-admin';

const FORCE = process.argv.includes('--force');
const PROJECT = process.env.GCLOUD_PROJECT || 'compilator-83816';
const BUCKET = process.env.STORAGE_BUCKET || `${PROJECT}.appspot.com`;

// Guard: refuse to run against the emulator — this must hit prod storage.
for (const v of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST']) {
  if (process.env[v]) {
    console.error(`Refusing to run: ${v} is set. This script targets production, not the emulator.`);
    process.exit(1);
  }
}

admin.initializeApp({ projectId: PROJECT, storageBucket: BUCKET });

// Import AFTER initializeApp so processing.js reuses our app (which has the
// storage bucket configured) instead of creating its own bucket-less default.
const { recomputeDurationsFromStore } = await import('../functions/processing.js');

const db = admin.firestore();

async function run() {
  console.log(`Project: ${PROJECT} (bucket: ${BUCKET})${FORCE ? ' — FORCE' : ''}`);
  const comps = await db.collection('compilations').get();
  console.log(`Scanning ${comps.size} compilation(s)…\n`);

  let totalChecked = 0;
  let totalFixed = 0;
  for (const c of comps.docs) {
    const title = c.data().title || c.id;
    try {
      const res = await recomputeDurationsFromStore({ compilationId: c.id, force: FORCE });
      totalChecked += res.checked;
      totalFixed += res.fixed;
      const note = res.fixed ? `repaired ${res.fixed}` : (res.checked ? 'all already correct' : 'up to date');
      console.log(`  ✓ ${title}: ${note} (${res.checked} checked / ${res.songCount} songs)`);
    } catch (err) {
      console.error(`  ✗ ${title} (${c.id}): ${err.message}`);
    }
  }

  console.log(`\nDone. ${totalFixed} duration(s) repaired (${totalChecked} song(s) checked) across ${comps.size} compilation(s).`);
}

run().catch((err) => { console.error(err); process.exit(1); });
