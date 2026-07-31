#!/usr/bin/env node
/**
 * Measure integrated loudness (LUFS) for every song and store it on the song doc
 * (`loudnessLufs` + `loudnessV`). The client reads this to normalize playback
 * gain so volume doesn't jump between tracks. Songs uploaded before this
 * pipeline existed have no value; run this once to backfill them.
 *
 * Idempotent: songs already at the current pipeline version are skipped, so it's
 * safe to re-run. Pass --force to re-measure every song regardless.
 *
 * Runs against the REAL project (no emulator). Authenticate first with either:
 *   gcloud auth application-default login          # uses your ADC
 *   # or set GOOGLE_APPLICATION_CREDENTIALS to a service-account key
 *
 * Usage:
 *   node scripts/backfill-loudness.js            # measure all compilations
 *   node scripts/backfill-loudness.js --force    # re-measure even done songs
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
const { recomputeLoudnessFromStore } = await import('../functions/processing.js');

const db = admin.firestore();

async function run() {
  console.log(`Project: ${PROJECT} (bucket: ${BUCKET})${FORCE ? ' — FORCE' : ''}`);
  const comps = await db.collection('compilations').get();
  console.log(`Scanning ${comps.size} compilation(s)…\n`);

  let totalChecked = 0;
  let totalUpdated = 0;
  for (const c of comps.docs) {
    const title = c.data().title || c.id;
    try {
      const res = await recomputeLoudnessFromStore({ compilationId: c.id, force: FORCE });
      totalChecked += res.checked;
      totalUpdated += res.updated;
      const note = res.updated ? `measured ${res.updated}` : (res.checked ? 'none measurable' : 'up to date');
      console.log(`  ✓ ${title}: ${note} (${res.checked} checked / ${res.songCount} songs)`);
    } catch (err) {
      console.error(`  ✗ ${title} (${c.id}): ${err.message}`);
    }
  }

  console.log(`\nDone. ${totalUpdated} loudness value(s) written (${totalChecked} song(s) checked) across ${comps.size} compilation(s).`);
}

run().catch((err) => { console.error(err); process.exit(1); });
