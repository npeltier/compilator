// Browser end-to-end test for the home view's multi-select filters.
//
// Unlike upload-flow.test.mjs (which drives Firestore/Storage directly via the
// SDK), this test drives the REAL client code — public/js/views/home.js and
// shuffle.js — in a headless browser, because those modules import the Firebase
// SDK from a CDN URL and only run in a browser.
//
// It seeds an isolated dataset (two synthetic authors × two season/years, each
// with songs) via the Admin SDK, then in Chromium:
//   1. logs in and opens the collapsed "Filtres" bar,
//   2. toggles multiple author + season chips at once,
//   3. asserts the compilation grid shows the (authors × seasons) intersection,
//   4. asserts the "Lire la sélection" button appears with the right count,
//   5. clicks it and asserts the player starts on the selected mix.
//
// Author scoping keeps assertions deterministic even if other compilations
// exist locally: once we constrain to our two synthetic authors, only their
// compilations can appear.
//
// Prerequisites: emulator suite running (npm run dev) + seeded login user
// (npm run seed). Run with:  npm run test:e2e:ui

import { strict as assert } from 'node:assert';
import admin from 'firebase-admin';
import { chromium } from 'playwright';

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
const PROJECT = process.env.GCLOUD_PROJECT || 'demo-compilator';
const HOSTING = process.env.HOSTING_URL || 'http://localhost:5050';
const EMAIL = 'peltier.nicolas@gmail.com';
const PASSWORD = 'password';

// Synthetic authors — emails that won't collide with real/seed data.
const ALPHA = 'ftest-alpha@example.com';
const BETA = 'ftest-beta@example.com';
const COMPS = [
  { id: 'ftestAlphaEte25', title: 'FTEST Alpha Été 2025', author: ALPHA, season: 'ete', year: 2025 },
  { id: 'ftestAlphaNoel24', title: 'FTEST Alpha Noël 2024', author: ALPHA, season: 'noel', year: 2024 },
  { id: 'ftestBetaEte25', title: 'FTEST Beta Été 2025', author: BETA, season: 'ete', year: 2025 },
  { id: 'ftestBetaNoel24', title: 'FTEST Beta Noël 2024', author: BETA, season: 'noel', year: 2024 },
];

const step = (l) => console.log(`\n→ ${l}`);
const ok = (m) => console.log(`  ✓ ${m}`);

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();
const FV = admin.firestore.FieldValue;

async function removeSeed() {
  for (const author of [ALPHA, BETA]) {
    const snap = await db.collection('compilations').where('author', '==', author).get();
    for (const d of snap.docs) {
      const songs = await d.ref.collection('songs').get();
      await Promise.all(songs.docs.map((s) => s.ref.delete()));
      await d.ref.delete();
    }
  }
  await db.doc(`users/${ALPHA}`).delete().catch(() => {});
  await db.doc(`users/${BETA}`).delete().catch(() => {});
}

async function writeSeed() {
  await db.doc(`users/${ALPHA}`).set({ displayName: 'Alpha', updatedAt: FV.serverTimestamp() });
  await db.doc(`users/${BETA}`).set({ displayName: 'Beta', updatedAt: FV.serverTimestamp() });
  for (const c of COMPS) {
    await db.collection('compilations').doc(c.id).set({
      title: c.title, author: c.author, season: c.season, year: c.year,
      status: 'published', trackCount: 2, totalDuration: 240,
      createdAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp(),
    });
    for (let i = 1; i <= 2; i++) {
      await db.collection('compilations').doc(c.id).collection('songs').doc(`${c.id}_s${i}`).set({
        title: `${c.title} – piste ${i}`, artist: c.author.split('@')[0], album: c.id, order: i,
        storagePath: `store/ftest-${c.id}-${i}.mp3`, duration: 120, addedAt: FV.serverTimestamp(),
      });
    }
  }
}

// ---- in-page helpers (run inside the browser) ----
// A chip's visible label is the text of its non-avatar span, or its whole text
// for chips without an avatar ("Tout", season chips).
const PAGE_HELPERS = `
  window.__chipLabel = (c) => {
    const s = c.querySelector('span:not(.avatar)');
    return (s ? s.textContent : c.textContent).trim();
  };
  window.__labels = (sel) => [...document.querySelectorAll(sel)].map(window.__chipLabel);
  window.__clickChip = (container, label) => {
    const chip = [...document.querySelectorAll(container + ' .chip')]
      .find((c) => window.__chipLabel(c) === label);
    if (!chip) return false;
    chip.click();
    return true;
  };
`;

async function run() {
  step('seed isolated dataset (2 authors × 2 season/years, 2 songs each)');
  await removeSeed();
  await writeSeed();
  ok(`seeded ${COMPS.length} compilations for Alpha & Beta`);

  const browser = await chromium.launch();
  const page = await browser.newContext({ viewport: { width: 1100, height: 900 } }).then((c) => c.newPage());
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  const labels = (sel) => page.evaluate((s) => window.__labels(s), sel);
  const gridTitles = () => page.$$eval('#years .cover-card .title', (els) => els.map((e) => e.textContent.trim()));
  const ftestTitles = async () => (await gridTitles()).filter((t) => t.startsWith('FTEST')).sort();
  const clickChip = async (container, label) => {
    const hit = await page.evaluate(([c, l]) => window.__clickChip(c, l), [container, label]);
    assert.ok(hit, `chip "${label}" not found in ${container}`);
    await page.waitForTimeout(120);
  };
  const selBtn = () => page.$eval('#sh-selection', (b) => ({ hidden: b.hidden, disabled: b.disabled, text: b.textContent.trim() }));

  try {
    step('log in and load the home view');
    await page.goto(`${HOSTING}/login.html`);
    await page.fill('#email', EMAIL);
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL((u) => !u.pathname.includes('login'), { timeout: 20000 });
    // Chips live inside the collapsed (display:none) filter bar, so wait for
    // them to be attached rather than visible.
    await page.waitForSelector('#authorChips .chip', { state: 'attached', timeout: 20000 });
    await page.addScriptTag({ content: PAGE_HELPERS });
    ok('logged in, author chips rendered');

    step('open the (collapsed) Filtres bar');
    assert.equal(await page.$eval('#filterBar', (b) => b.classList.contains('collapsed')), true, 'bar should start collapsed');
    await page.click('#filterToggle');
    await page.waitForTimeout(200);
    assert.equal(await page.$eval('#filterBar', (b) => b.classList.contains('collapsed')), false, 'bar should expand on toggle');
    ok('filter bar expanded');
    assert.deepEqual(await selBtn().then((b) => b.hidden), true, 'selection button hidden with no filter');
    ok('selection button hidden initially');

    step('multi-select TWO authors at once (Alpha + Beta)');
    await clickChip('#authorChips', 'Alpha');
    await clickChip('#authorChips', 'Beta');
    const activeAuthors = (await labels('#authorChips .chip.active')).sort();
    assert.deepEqual(activeAuthors, ['Alpha', 'Beta'], `expected both authors active, got ${JSON.stringify(activeAuthors)}`);
    ok(`two authors active simultaneously: ${activeAuthors.join(', ')}`);

    step('add ONE season (Été 2025) → grid is the (authors × season) intersection');
    await clickChip('#seasonChips', 'Été 2025');
    let grid = await ftestTitles();
    assert.deepEqual(grid, ['FTEST Alpha Été 2025', 'FTEST Beta Été 2025'],
      `expected only the two Été comps, got ${JSON.stringify(grid)}`);
    let btn = await selBtn();
    assert.equal(btn.hidden, false, 'selection button should be visible');
    assert.match(btn.text, /2 compils/, `expected "2 compils" in button, got "${btn.text}"`);
    ok(`grid = 2 Été comps; button = "${btn.text}"`);

    step('multi-select a SECOND season (Noël 2024) → 2 authors × 2 seasons = 4');
    await clickChip('#seasonChips', 'Noël 2024');
    const activeSeasons = (await labels('#seasonChips .chip.active')).sort();
    assert.deepEqual(activeSeasons, ['Noël 2024', 'Été 2025'].sort(), `expected both seasons active, got ${JSON.stringify(activeSeasons)}`);
    grid = await ftestTitles();
    assert.deepEqual(grid, COMPS.map((c) => c.title).sort(), `expected all 4 comps, got ${JSON.stringify(grid)}`);
    btn = await selBtn();
    assert.match(btn.text, /4 compils/, `expected "4 compils", got "${btn.text}"`);
    ok(`two seasons active; grid = 4 comps; button = "${btn.text}"`);

    step('deselect one author (Beta) → grid narrows to Alpha across both seasons');
    await clickChip('#authorChips', 'Beta');
    grid = await ftestTitles();
    assert.deepEqual(grid, ['FTEST Alpha Noël 2024', 'FTEST Alpha Été 2025'].sort(),
      `expected Alpha's two comps, got ${JSON.stringify(grid)}`);
    assert.match((await selBtn()).text, /2 compils/, 'button should drop back to 2');
    ok('selection updates live as chips toggle off');

    step('"Lire la sélection" starts playback of the selected mix');
    await clickChip('#authorChips', 'Beta'); // back to 4 comps for a richer mix
    await page.click('#sh-selection');
    await page.waitForTimeout(600);
    const player = await page.evaluate(() => ({
      hasPlayer: document.body.classList.contains('has-player'),
      barVisible: !document.querySelector('.player-bar')?.hidden,
      title: document.querySelector('#pb-title')?.textContent?.trim(),
      source: document.querySelector('#pb-source')?.textContent?.trim(),
    }));
    assert.equal(player.hasPlayer, true, 'body should have has-player class');
    assert.equal(player.barVisible, true, 'player bar should be visible');
    assert.match(player.title || '', /^FTEST .* – piste \d$/, `now-playing should be a seeded song, got "${player.title}"`);
    assert.match(player.source || '', /^Sélection ·/, `source label should describe the selection, got "${player.source}"`);
    ok(`playing "${player.title}" — source "${player.source}"`);

    step('reset with the "Tout" chips → selection button hides again');
    await clickChip('#authorChips', 'Tout');
    await clickChip('#seasonChips', 'Tout');
    assert.equal((await selBtn()).hidden, true, 'selection button hidden after reset');
    const all = new Set(await gridTitles());
    for (const c of COMPS) assert.ok(all.has(c.title), `expected ${c.title} visible after reset`);
    ok('reset clears the selection and shows all compilations');

    assert.deepEqual(pageErrors, [], `unexpected page errors: ${JSON.stringify(pageErrors)}`);
  } finally {
    await browser.close();
    await removeSeed();
  }
}

run()
  .then(() => { console.log('\n✅ home-filters e2e passed'); process.exit(0); })
  .catch((err) => { console.error('\n❌ home-filters e2e FAILED\n', err); process.exit(1); });
