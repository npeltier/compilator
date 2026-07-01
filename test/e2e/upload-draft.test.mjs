// Browser end-to-end test for the /upload draft → publish flow and the
// one-compilation-per-author-per-season rule, driving the real upload view.
//
//   1. /upload with no draft → fill title, add a track, "Enregistrer le brouillon"
//      → a draft compilation exists with the song uploaded,
//   2. reload /upload → the draft is reloaded (title prefilled, song shown), add a
//      second track and "Publier" → navigates to /c/:id, status published, 2 songs,
//   3. /upload again → "Déjà publiée" (can't create a second for the season).
//
// Needs ffmpeg (for MP3 fixtures), emulators running, and the seeded login user.
// Run with:  npm run test:e2e:upload-draft

import { strict as assert } from 'node:assert';
import admin from 'firebase-admin';
import { chromium } from 'playwright';
import { buildMp3 } from './fixtures.mjs';
import { nextCompilationSlot } from '../../public/js/slot.js';

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
const PROJECT = process.env.GCLOUD_PROJECT || 'demo-compilator';
const HOSTING = process.env.HOSTING_URL || 'http://localhost:5050';
const EMAIL = 'peltier.nicolas@gmail.com';
const PASSWORD = 'password';

const step = (l) => console.log(`\n→ ${l}`);
const ok = (m) => console.log(`  ✓ ${m}`);

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

// Reuse the app's own slot logic (public/js/slot.js) so the test always targets &
// cleans the same author/season compilation the upload view creates, regardless of
// when the test runs — no hand-maintained copy to drift out of sync.
const slot = nextCompilationSlot();

async function removeMine() {
  const snap = await db.collection('compilations')
    .where('author', '==', EMAIL).where('season', '==', slot.season).where('year', '==', slot.year).get();
  for (const d of snap.docs) {
    const songs = await d.ref.collection('songs').get();
    await Promise.all(songs.docs.map((s) => s.ref.delete()));
    await d.ref.delete();
  }
  return snap.size;
}

async function myComp() {
  const snap = await db.collection('compilations')
    .where('author', '==', EMAIL).where('season', '==', slot.season).where('year', '==', slot.year).get();
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}
async function songCount(id) {
  return (await db.collection('compilations').doc(id).collection('songs').get()).size;
}

async function run() {
  step('clean any existing compilation for this author + season');
  ok(`removed ${await removeMine()} (slot: ${slot.season} ${slot.year})`);

  const t1 = buildMp3({ index: 1, title: 'Brouillon Un', artist: 'Ted', album: 'D', year: slot.year });
  const t2 = buildMp3({ index: 2, title: 'Brouillon Deux', artist: 'Mae', album: 'D', year: slot.year });

  const browser = await chromium.launch();
  const page = await browser.newContext({ viewport: { width: 1100, height: 900 } }).then((c) => c.newPage());
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  const gotoUpload = async () => {
    await page.goto(`${HOSTING}/upload`);
    await page.waitForSelector('#title, h1', { timeout: 20000 });
  };

  try {
    step('log in');
    await page.goto(`${HOSTING}/login.html`);
    await page.fill('#email', EMAIL);
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL((u) => !u.pathname.includes('login'), { timeout: 20000 });
    await page.waitForSelector('#shuffleRow', { timeout: 20000 }); // app booted
    ok('logged in');

    step('open /upload (fresh) and save a draft with one track');
    await gotoUpload();
    assert.equal(await page.$eval('#title', (e) => e.value), '', 'title should start empty');
    await page.fill('#title', 'Mon brouillon');
    await page.setInputFiles('#songsInput', t1);
    await page.waitForFunction(() => document.querySelectorAll('#queue li').length === 1, null, { timeout: 20000 });
    await page.click('#saveDraft');
    await page.waitForSelector('#ok:not([hidden])', { timeout: 30000 });
    ok('draft saved (notice shown)');

    let comp = await myComp();
    assert.ok(comp, 'a compilation should now exist');
    assert.equal(comp.status, 'draft', `status should be draft, got ${comp.status}`);
    assert.equal(comp.title, 'Mon brouillon');
    assert.equal(await songCount(comp.id), 1, 'draft should have 1 uploaded song');
    const draftId = comp.id;
    ok(`draft ${draftId}: status=draft, 1 song`);

    step('reload /upload → the draft is reloaded; add a second track and publish');
    await gotoUpload();
    assert.equal(await page.$eval('#title', (e) => e.value), 'Mon brouillon', 'title should be prefilled from the draft');
    await page.waitForFunction(() => document.querySelectorAll('#queue li').length === 1, null, { timeout: 20000 });
    ok('existing song reloaded into the editor');
    await page.setInputFiles('#songsInput', t2);
    await page.waitForFunction(() => document.querySelectorAll('#queue li').length === 2, null, { timeout: 20000 });
    await page.click('#publish');
    await page.waitForURL((u) => u.pathname === `/c/${draftId}`, { timeout: 30000 });
    ok(`published → navigated to /c/${draftId}`);

    comp = await myComp();
    assert.equal(comp.id, draftId, 'should still be the same compilation (no second one)');
    assert.equal(comp.status, 'published', `status should be published, got ${comp.status}`);
    assert.equal(await songCount(comp.id), 2, 'published comp should have 2 songs');
    ok('same compilation, status=published, 2 songs');

    step('open /upload again → one-per-season: shows "déjà publiée"');
    await gotoUpload();
    const h1 = await page.$eval('h1', (e) => e.textContent.trim());
    assert.match(h1, /Déjà publiée/i, `expected the "déjà publiée" screen, got "${h1}"`);
    const linkHref = await page.$eval(`a[href="/c/${draftId}"]`, (a) => a.getAttribute('href')).catch(() => null);
    assert.equal(linkHref, `/c/${draftId}`, 'should link to the published compilation');
    ok('second compilation blocked; links to the existing one');

    assert.deepEqual(pageErrors, [], `unexpected page errors: ${JSON.stringify(pageErrors)}`);
  } finally {
    await browser.close();
    await removeMine();
  }
}

run()
  .then(() => { console.log('\n✅ upload-draft e2e passed'); process.exit(0); })
  .catch((err) => { console.error('\n❌ upload-draft e2e FAILED\n', err); process.exit(1); });
