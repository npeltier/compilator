// Browser end-to-end test for the home view's unified include/exclude filters.
//
// Unlike upload-flow.test.mjs (which drives Firestore/Storage directly via the
// SDK), this test drives the REAL client code — public/js/views/home.js,
// shuffle.js and saved-filters.js — in a headless browser, because those
// modules import the Firebase SDK from a CDN URL and only run in a browser.
//
// It seeds an isolated dataset (two synthetic authors across seasons/years,
// each with songs) via the Admin SDK, then in Chromium:
//   1. logs in and opens the collapsed "Filtres" bar,
//   2. include-toggles authors and the now-decoupled season + year chips,
//   3. asserts the grid is the intersection and renders summer before winter,
//   4. exercises the tri-state cycle (include → exclude → neutral),
//   5. plays "Lire la sélection" and checks the "+ − −" source label,
//   6. saves the filter, asserts it persists to Firestore and plays from the
//      top shuffle row, then deletes it.
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
// Same-year summer+winter (2025) lets us assert summer-before-winter ordering;
// the 2024 winter lets us assert the year chip filters independently of season.
const COMPS = [
  { id: 'ftestAlphaEte25', title: 'FTEST Alpha Été 2025', author: ALPHA, season: 'ete', year: 2025 },
  { id: 'ftestAlphaNoel25', title: 'FTEST Alpha Noël 2025', author: ALPHA, season: 'noel', year: 2025 },
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
  // Saved filters live under the login user's doc, not the synthetic authors'.
  const sf = await db.collection(`users/${EMAIL}/savedFilters`).get();
  await Promise.all(sf.docs.map((d) => d.ref.delete()));
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
// A chip's visible label is the text of its non-avatar span (every chip now
// wraps its label in a <span>; excluded chips also carry a leading "🚫 ").
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
  step('seed isolated dataset (2 authors across seasons/years, 2 songs each)');
  await removeSeed();
  await writeSeed();
  ok(`seeded ${COMPS.length} compilations for Alpha & Beta`);

  const browser = await chromium.launch();
  const page = await browser.newContext({ viewport: { width: 1100, height: 900 } }).then((c) => c.newPage());
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  const labels = (sel) => page.evaluate((s) => window.__labels(s), sel);
  const gridTitles = () => page.$$eval('#years .cover-card .title', (els) => els.map((e) => e.textContent.trim()));
  const ftestOrdered = async () => (await gridTitles()).filter((t) => t.startsWith('FTEST'));
  const ftestTitles = async () => (await ftestOrdered()).sort();
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
    assert.equal(await selBtn().then((b) => b.hidden), true, 'selection button hidden with no filter');
    ok('filter bar expanded; selection button hidden initially');

    step('season (emoji) chips live inside the years pane; year chips alongside');
    // Seasons are now rendered as emoji (☀️ Été, 🎄 Noël) nested in the years
    // <details>. Other (real/seed) compilations may exist locally, so assert our
    // chips are PRESENT rather than asserting the full set.
    const seasonChips = (await labels('#seasonChips .chip')).filter((l) => l !== 'Tout');
    const yearChips = (await labels('#yearChips .chip')).filter((l) => l !== 'Tout');
    for (const s of ['☀️', '🎄']) assert.ok(seasonChips.includes(s), `season chip "${s}" missing, got ${JSON.stringify(seasonChips)}`);
    for (const y of ['2024', '2025']) assert.ok(yearChips.includes(y), `year chip "${y}" missing, got ${JSON.stringify(yearChips)}`);
    ok(`season chips include ☀️/🎄; year chips include 2024/2025`);

    step('include TWO authors at once (Alpha + Beta)');
    await clickChip('#authorChips', 'Alpha');
    await clickChip('#authorChips', 'Beta');
    const activeAuthors = (await labels('#authorChips .chip.active')).sort();
    assert.deepEqual(activeAuthors, ['Alpha', 'Beta'], `expected both authors included, got ${JSON.stringify(activeAuthors)}`);
    ok(`two authors included simultaneously: ${activeAuthors.join(', ')}`);

    step('include season "Été" (☀️, decoupled from year) → only summer comps');
    await clickChip('#seasonChips', '☀️');
    let grid = await ftestTitles();
    assert.deepEqual(grid, ['FTEST Alpha Été 2025', 'FTEST Beta Été 2025'],
      `expected only the two summer comps, got ${JSON.stringify(grid)}`);
    let btn = await selBtn();
    assert.equal(btn.hidden, false, 'selection button should be visible');
    assert.match(btn.text, /2 compils/, `expected "2 compils", got "${btn.text}"`);
    ok(`grid = 2 summer comps; button = "${btn.text}"`);

    step('also include "Noël" (🎄) → all four comps (both seasons)');
    await clickChip('#seasonChips', '🎄');
    grid = await ftestTitles();
    assert.deepEqual(grid, COMPS.map((c) => c.title).sort(), `expected all 4 comps, got ${JSON.stringify(grid)}`);
    assert.match((await selBtn()).text, /4 compils/, 'expected "4 compils"');
    ok('two seasons included; grid = 4 comps');

    step('reset seasons + authors, then include YEAR 2025 alone → year filters independently');
    await clickChip('#seasonChips', 'Tout');
    await clickChip('#authorChips', 'Tout');
    await clickChip('#yearChips', '2025');
    grid = await ftestTitles();
    assert.deepEqual(grid, ['FTEST Alpha Noël 2025', 'FTEST Alpha Été 2025', 'FTEST Beta Été 2025'].sort(),
      `expected the three 2025 comps, got ${JSON.stringify(grid)}`);
    ok('year chip filters across seasons/authors on its own');

    step('summer renders before winter within the same year');
    const ordered = await ftestOrdered();
    const lastEte = ordered.map((t) => /Été/.test(t)).lastIndexOf(true);
    const firstNoel = ordered.findIndex((t) => /Noël/.test(t));
    assert.ok(lastEte >= 0 && firstNoel >= 0 && lastEte < firstNoel,
      `summer should precede winter in DOM order, got ${JSON.stringify(ordered)}`);
    ok(`grid order: ${ordered.join(' | ')}`);

    step('tri-state: include Alpha, then EXCLUDE Beta (click twice)');
    await clickChip('#yearChips', 'Tout');
    await clickChip('#authorChips', 'Alpha');     // include
    await clickChip('#authorChips', 'Beta');      // → include
    await clickChip('#authorChips', 'Beta');      // → exclude
    const excAuthors = await labels('#authorChips .chip.exc');
    const incAuthors = await labels('#authorChips .chip.active');
    assert.deepEqual(excAuthors, ['Beta'], `expected Beta excluded, got ${JSON.stringify(excAuthors)}`);
    assert.ok(incAuthors.includes('Alpha'), `expected Alpha included, got ${JSON.stringify(incAuthors)}`);
    grid = await ftestTitles();
    assert.deepEqual(grid, ['FTEST Alpha Noël 2025', 'FTEST Alpha Été 2025'].sort(),
      `include-Alpha + exclude-Beta should yield Alpha's two comps, got ${JSON.stringify(grid)}`);
    ok('exclude drops Beta; include keeps Alpha');

    step('"Lire la sélection" plays the mix with a "+ − −" source label');
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
    assert.match(player.title || '', /^FTEST Alpha .* – piste \d$/, `now-playing should be an Alpha song, got "${player.title}"`);
    assert.ok((player.source || '').includes('Alpha') && (player.source || '').includes('Beta') && (player.source || '').includes('−'),
      `source label should read "Alpha − Beta", got "${player.source}"`);
    ok(`playing "${player.title}" — source "${player.source}"`);

    step('save the filter → persists to Firestore and appears in the shuffle row');
    await page.click('#sh-save');
    await page.waitForSelector('.saved-filter .sf-play', { timeout: 5000 });
    const sfLabel = await page.$eval('.saved-filter .sf-play', (b) => b.textContent.trim());
    assert.ok(sfLabel.includes('Alpha') && sfLabel.includes('Beta'), `saved button label, got "${sfLabel}"`);
    // The UI button appears from the in-memory cache before the async setDoc
    // commits, so poll the emulator until the write lands.
    let savedDocs;
    for (let i = 0; i < 20; i++) {
      savedDocs = await db.collection(`users/${EMAIL}/savedFilters`).get();
      if (savedDocs.size >= 1) break;
      await page.waitForTimeout(150);
    }
    assert.equal(savedDocs.size, 1, `expected 1 saved filter in Firestore, got ${savedDocs.size}`);
    const saved = savedDocs.docs[0].data();
    assert.deepEqual(saved.inc.authors, [ALPHA], `saved inc.authors, got ${JSON.stringify(saved.inc?.authors)}`);
    assert.deepEqual(saved.exc.authors, [BETA], `saved exc.authors, got ${JSON.stringify(saved.exc?.authors)}`);
    ok(`saved filter persisted: "${sfLabel}"`);

    step('reset filters, then play the saved filter from the shuffle row');
    await clickChip('#authorChips', 'Tout');
    assert.equal((await selBtn()).hidden, true, 'selection button hidden after reset');
    await page.click('.saved-filter .sf-play');
    await page.waitForTimeout(600);
    const replay = await page.evaluate(() => document.querySelector('#pb-source')?.textContent?.trim());
    assert.ok((replay || '').includes('Alpha'), `saved filter playback source, got "${replay}"`);
    ok(`saved filter replays — source "${replay}"`);

    step('delete the saved filter → button disappears and Firestore doc is gone');
    await page.click('.saved-filter .sf-del');
    await page.waitForFunction(() => !document.querySelector('.saved-filter'), { timeout: 5000 });
    let afterDelete;
    for (let i = 0; i < 20; i++) {
      afterDelete = await db.collection(`users/${EMAIL}/savedFilters`).get();
      if (afterDelete.size === 0) break;
      await page.waitForTimeout(150);
    }
    assert.equal(afterDelete.size, 0, `expected 0 saved filters after delete, got ${afterDelete.size}`);
    ok('saved filter deleted from UI and Firestore');

    assert.deepEqual(pageErrors, [], `unexpected page errors: ${JSON.stringify(pageErrors)}`);
  } finally {
    await browser.close();
    await removeSeed();
  }
}

run()
  .then(() => { console.log('\n✅ home-filters e2e passed'); process.exit(0); })
  .catch((err) => { console.error('\n❌ home-filters e2e FAILED\n', err); process.exit(1); });
