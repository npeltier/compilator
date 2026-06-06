#!/usr/bin/env node
/**
 * Rebuild doublons for every song in the database.
 * Run once after deploying the feature, or whenever you need to resync.
 *
 * Usage:
 *   node scripts/compute-doublons.js
 *
 * Requires application default credentials or GOOGLE_APPLICATION_CREDENTIALS:
 *   gcloud auth application-default login
 *   # or
 *   GOOGLE_APPLICATION_CREDENTIALS=./service-account-key.json node scripts/compute-doublons.js
 */

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';
import { rebuildAllDoublons } from '../functions/doublons.js';

const PROJECT = process.env.GCLOUD_PROJECT
  || JSON.parse(readFileSync(new URL('../.firebaserc', import.meta.url))).projects.default;

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: PROJECT });
}

const db = getFirestore();

async function run() {
  console.log(`Project: ${PROJECT}`);
  console.log('Fetching all songs and computing doublons…');
  const count = await rebuildAllDoublons(db);
  console.log(`Done. ${count} song(s) updated.`);
}

run().catch((err) => { console.error(err); process.exit(1); });
