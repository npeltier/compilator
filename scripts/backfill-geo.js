#!/usr/bin/env node
/**
 * Backfill artist geography (country / region / town) onto song docs via
 * MusicBrainz. Country/region are per-ARTIST, so this resolves each unique
 * artist once (cached in artistMeta/{normalizedArtist}) and fans the result out
 * to all of that artist's songs — keeping us well under MusicBrainz's 1 req/s.
 *
 * Idempotent: songs already resolved at the current geo pipeline version are
 * skipped, so it's safe to re-run. Songs whose lookup came back empty
 * (geoSource 'none') are NOT considered done and get retried on each run — a
 * failed resolution shouldn't be permanent. Pass --force to re-resolve every
 * artist, resolved or not.
 *
 * Runs against the REAL project (no emulator). Authenticate first with either:
 *   gcloud auth application-default login          # uses your ADC
 *   # or set GOOGLE_APPLICATION_CREDENTIALS to a service-account key
 *
 * Usage:
 *   node scripts/backfill-geo.js            # fill missing geo for all songs
 *   node scripts/backfill-geo.js --force    # re-resolve even already-done songs
 *   node scripts/backfill-geo.js --recheck=musicbrainz
 *       # re-resolve only songs with these geoSource values, bypassing both the
 *       # done check and the artistMeta cache. Use after a change to the
 *       # resolution rules that affects one source — e.g. the namesake-ambiguity
 *       # check, which only applies to bare 'musicbrainz' name matches. Far
 *       # cheaper than --force (hundreds of artists, not thousands).
 */
import admin from 'firebase-admin';

const FORCE = process.argv.includes('--force');
const RECHECK = new Set(
  (process.argv.find((a) => a.startsWith('--recheck='))?.slice('--recheck='.length) || '')
    .split(',').map((s) => s.trim()).filter(Boolean),
);
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
const { resolveArtistGeo, geoSongFields, isGeoResolved } = await import('../functions/geo.js');
const { normalizeArtist } = await import('../functions/doublons.js');
const { isVariousArtist } = await import('../functions/discogs.js');

const db = admin.firestore();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  console.log(`Project: ${PROJECT}${FORCE ? ' — FORCE' : ''}${RECHECK.size ? ` — RECHECK ${[...RECHECK].join(',')}` : ''}`);
  const songs = await db.collectionGroup('songs').get();
  console.log(`Scanning ${songs.size} song(s)…`);

  // Group by the SAME key the cache uses — Discogs artist id when present, else
  // normalized name — so distinct same-named artists resolve separately. Skip
  // songs a human has corrected (geoManual) and those already at this version.
  const byArtist = new Map(); // key → { raw, discogsArtistId, force, refs: [DocRef] }
  for (const d of songs.docs) {
    const s = d.data();
    const raw = s.artist;
    const name = normalizeArtist(raw);
    if (!name || isVariousArtist(raw)) continue;
    if (s.geoManual) continue; // never overwrite a manual correction
    // A --recheck target is re-resolved even though it looks done, and must also
    // bypass the artistMeta cache (which would hand back the very answer we're
    // rechecking) — hence the per-artist force below.
    const recheck = RECHECK.has(s.geoSource || 'none');
    // Note: NOT `geoV === GEO_VERSION` — a song whose lookup came back 'none' or
    // ambiguous is retried on every run rather than retired at the current version.
    if (!FORCE && !recheck && isGeoResolved(s)) continue;
    const discogsArtistId = s.discogs?.artistId || null;
    const key = discogsArtistId ? `discogs-${discogsArtistId}` : name;
    let g = byArtist.get(key);
    if (!g) { g = { raw, discogsArtistId, force: false, refs: [] }; byArtist.set(key, g); }
    g.force ||= recheck;
    g.refs.push(d.ref);
  }
  console.log(`${byArtist.size} unique artist(s) need resolution.\n`);

  let resolved = 0;
  let withCountry = 0;
  let songsWritten = 0;
  for (const [, { raw, discogsArtistId, force, refs }] of byArtist) {
    try {
      const geo = await resolveArtistGeo(db, raw, { discogsArtistId, delayMs: 1100, force: FORCE || force });
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
