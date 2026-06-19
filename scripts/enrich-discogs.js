#!/usr/bin/env node
/**
 * Backfill Discogs enrichment for every existing song (year, label, artist bio,
 * country, release link). Idempotent and resumable — songs that already carry an
 * `enrichStatus`/`enrichedAt` are skipped, so you can re-run it any time.
 *
 * Usage:
 *   node scripts/enrich-discogs.js
 *   node scripts/enrich-discogs.js --force      # re-enrich everything
 *
 * Token: $DISCOGS_TOKEN if set, otherwise the first admin's stored token
 * (/users/{adminEmail}/private/discogs.token).
 *
 * Requires application default credentials or GOOGLE_APPLICATION_CREDENTIALS:
 *   gcloud auth application-default login
 *   # or
 *   GOOGLE_APPLICATION_CREDENTIALS=./service-account-key.json node scripts/enrich-discogs.js
 */

import admin from 'firebase-admin';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';
import { enrichSong } from '../functions/discogs.js';

const PROJECT = process.env.GCLOUD_PROJECT
  || JSON.parse(readFileSync(new URL('../.firebaserc', import.meta.url))).projects.default;

const FORCE = process.argv.includes('--force');

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: PROJECT });
}

const db = getFirestore();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function firstAdminToken() {
  const admins = await db.collection('admins').get();
  for (const a of admins.docs) {
    const snap = await db.doc(`users/${a.id}/private/discogs`).get();
    if (snap.exists && snap.data().token) return snap.data().token;
  }
  return null;
}

async function run() {
  console.log(`Project: ${PROJECT}`);
  const token = process.env.DISCOGS_TOKEN || await firstAdminToken();
  if (!token) {
    console.error('No Discogs token. Set DISCOGS_TOKEN or store one in an admin profile.');
    process.exit(1);
  }

  const snap = await db.collectionGroup('songs').get();
  const songs = [];
  snap.forEach((d) => songs.push({ ref: d.ref, data: d.data() }));
  console.log(`${songs.length} song(s) found. ${FORCE ? 'Re-enriching all.' : 'Skipping already-enriched.'}`);

  const tally = { done: 0, skipped: 0, nomatch: 0, error: 0, already: 0 };
  for (const { ref, data } of songs) {
    if (!FORCE && (data.enrichStatus || data.enrichedAt)) { tally.already++; continue; }
    try {
      const fields = await enrichSong(data, token);
      await ref.set({ ...fields, enrichedAt: FieldValue.serverTimestamp() }, { merge: true });
      tally[fields.enrichStatus] = (tally[fields.enrichStatus] || 0) + 1;
      console.log(`${fields.enrichStatus.padEnd(7)} ${data.artist || '?'} – ${data.title || '?'}`);
    } catch (err) {
      tally.error++;
      await ref.set({ enrichStatus: 'error', enrichedAt: FieldValue.serverTimestamp() }, { merge: true });
      console.warn(`error   ${data.artist || '?'} – ${data.title || '?'}: ${err.message}`);
    }
    // enrichSong already spaces its own API calls; a small gap between songs.
    await sleep(300);
  }

  console.log(`Done. ${JSON.stringify(tally)}`);
}

run().catch((err) => { console.error(err); process.exit(1); });
