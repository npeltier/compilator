#!/usr/bin/env node
/**
 * Backfill artist geography (country / region / town) onto song docs via
 * MusicBrainz. Country/region are per-ARTIST, so this resolves each unique
 * artist once (cached in artistMeta/{normalizedArtist}) and fans the result out
 * to all of that artist's songs — keeping us well under MusicBrainz's 1 req/s.
 *
 * Idempotent: songs already at the current geo pipeline version are skipped, so
 * it's safe to re-run. Pass --force to re-resolve every artist regardless.
 *
 * Runs against the REAL project (no emulator). Authenticate first with either:
 *   gcloud auth application-default login          # uses your ADC
 *   # or set GOOGLE_APPLICATION_CREDENTIALS to a service-account key
 *
 * Usage:
 *   node scripts/backfill-geo.js            # fill missing geo for all songs
 *   node scripts/backfill-geo.js --force    # re-resolve even already-done songs
 */
import admin from 'firebase-admin';

const FORCE = process.argv.includes('--force');
const PROJECT = process.env.GCLOUD_PROJECT || 'compilator-83816';
const BUCKET = process.env.STORAGE_BUCKET || `${PROJECT}.appspot.com`;

for (const v of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST']) {
  if (process.env[v]) {
    console.error(`Refusing to run: ${v} is set. This script targets production, not the emulator.`);
    process.exit(1);
  }
}

admin.initializeApp({ projectId: PROJECT, storageBucket: BUCKET });

// Import AFTER initializeApp so the shared modules reuse our configured app.
const { resolveArtistGeo, geoSongFields, GEO_VERSION } = await import('../functions/geo.js');
const { normalizeArtist } = await import('../functions/doublons.js');
const { isVariousArtist } = await import('../functions/discogs.js');

const db = admin.firestore();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  console.log(`Project: ${PROJECT}${FORCE ? ' — FORCE' : ''}`);
  const songs = await db.collectionGroup('songs').get();
  console.log(`Scanning ${songs.size} song(s)…`);

  // Group songs by normalized artist; keep only songs that still need geo.
  const byArtist = new Map(); // key → { raw, refs: [DocRef] }
  for (const d of songs.docs) {
    const s = d.data();
    const raw = s.artist;
    const key = normalizeArtist(raw);
    if (!key || isVariousArtist(raw)) continue;
    if (!FORCE && s.geoV === GEO_VERSION) continue;
    let g = byArtist.get(key);
    if (!g) { g = { raw, refs: [] }; byArtist.set(key, g); }
    g.refs.push(d.ref);
  }
  console.log(`${byArtist.size} unique artist(s) need resolution.\n`);

  let resolved = 0;
  let withCountry = 0;
  let songsWritten = 0;
  for (const [, { raw, refs }] of byArtist) {
    try {
      const geo = await resolveArtistGeo(db, raw, null, { delayMs: 1100, force: FORCE });
      resolved += 1;
      if (geo?.countryCode || geo?.country) withCountry += 1;
      const fields = geoSongFields(geo);
      const writer = db.bulkWriter();
      for (const ref of refs) { writer.set(ref, fields, { merge: true }); songsWritten += 1; }
      await writer.close();
      const loc = [geo?.town, geo?.region, geo?.country].filter(Boolean).join(', ') || '—';
      console.log(`  ✓ ${raw}: ${loc} [${geo?.source}] → ${refs.length} song(s) [${resolved}/${byArtist.size}]`);
    } catch (err) {
      console.error(`  ✗ ${raw}: ${err.message}`);
    }
    await sleep(1100); // stay under MusicBrainz's 1 req/s between artists
  }

  console.log(`\nDone. Resolved ${resolved} artist(s) (${withCountry} with a country), wrote ${songsWritten} song(s).`);
}

run().catch((err) => { console.error(err); process.exit(1); });
