#!/usr/bin/env node
/**
 * Backfills /accessRequests from orphaned Firebase Auth accounts.
 *
 * The Membres screen's "Demandes d'accès" list is populated by the requestAccess
 * callable, which only started recording attempts once that feature shipped.
 * Anyone who signed up BEFORE the deploy left no /accessRequests entry — but if
 * they used "Créer un compte", Firebase created an Auth account for them before
 * the allowlist check signed them out. This script finds those Auth accounts
 * (email exists in Auth but NOT in /allowlist and NOT in /admins) and, with
 * --write, seeds a /accessRequests/{email} doc so they show up for approve/deny.
 *
 * Report-only by default. Runs against the REAL project (no emulator).
 * Authenticate first with:
 *   gcloud auth application-default login
 *
 * Usage:
 *   node scripts/backfill-access-requests.js           # report
 *   node scripts/backfill-access-requests.js --write   # report + seed /accessRequests
 */
import admin from 'firebase-admin';

const WRITE = process.argv.includes('--write');
const PROJECT = process.env.GCLOUD_PROJECT || 'compilator-83816';

// Guard: refuse to run against the emulator — this backfills production.
for (const v of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']) {
  if (process.env[v]) {
    console.error(`Refusing to run: ${v} is set. This script targets production, not the emulator.`);
    process.exit(1);
  }
}

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();
const auth = admin.auth();
const { FieldValue, Timestamp } = admin.firestore;

// Emails already on the allowlist or in /admins — these are legitimate members,
// never access requests.
async function loadKnownEmails() {
  const [allow, admins] = await Promise.all([
    db.collection('allowlist').get(),
    db.collection('admins').get(),
  ]);
  const known = new Set();
  allow.forEach((d) => known.add(d.id.toLowerCase()));
  admins.forEach((d) => known.add(d.id.toLowerCase()));
  return known;
}

// Every Firebase Auth user, paginated (listUsers returns up to 1000 at a time).
async function listAllAuthUsers() {
  const users = [];
  let pageToken;
  do {
    const res = await auth.listUsers(1000, pageToken);
    users.push(...res.users);
    pageToken = res.pageToken;
  } while (pageToken);
  return users;
}

async function main() {
  console.log(`Scanning Firebase Auth in project "${PROJECT}"…`);
  const [known, authUsers] = await Promise.all([loadKnownEmails(), listAllAuthUsers()]);

  // Orphans: an Auth account whose email isn't allowlisted/admin. Skip accounts
  // with no email (shouldn't happen for email/password) to be safe.
  const orphans = authUsers.filter((u) => u.email && !known.has(u.email.toLowerCase()));

  if (orphans.length === 0) {
    console.log('No orphaned Auth accounts found — nothing to backfill.');
    return;
  }

  console.log(`Found ${orphans.length} Auth account(s) not on the allowlist:\n`);
  for (const u of orphans) {
    const created = u.metadata?.creationTime || 'unknown';
    console.log(`  • ${u.email}${u.displayName ? ` (${u.displayName})` : ''} — created ${created}`);
  }

  if (!WRITE) {
    console.log(`\nReport only. Re-run with --write to seed these into /accessRequests.`);
    return;
  }

  console.log(`\nSeeding /accessRequests…`);
  let written = 0;
  for (const u of orphans) {
    const key = u.email.toLowerCase();
    // Don't clobber a real request the live flow may have recorded since.
    const existing = await db.collection('accessRequests').doc(key).get();
    if (existing.exists) {
      console.log(`  ↷ ${key} already has a request — skipped.`);
      continue;
    }
    // Use the account creation time as the "requested at" so the list sorts
    // sensibly; fall back to server time if it can't be parsed.
    let requestedAt = FieldValue.serverTimestamp();
    const created = u.metadata?.creationTime;
    if (created) {
      const d = new Date(created);
      if (!Number.isNaN(d.getTime())) requestedAt = Timestamp.fromDate(d);
    }
    await db.collection('accessRequests').doc(key).set({
      email: key,
      displayName: u.displayName || null,
      requestedAt,
      source: 'backfill',
    }, { merge: true });
    written++;
    console.log(`  ✓ ${key}`);
  }
  console.log(`\nDone. Seeded ${written} request(s). They now appear on the Membres screen.`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
