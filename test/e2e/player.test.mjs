// Browser end-to-end test for top-bar search + the audio player, driving the
// real client modules (search.js, player.js) in a headless browser.
//
// Seeds an isolated dataset with REAL (sine-tone WAV) audio uploaded to the
// Storage emulator, so playback genuinely starts — then exercises every use
// case around search → play:
//   1. search by SONG name → click a result → that track plays,
//   2. play/pause toggle + next/prev within the compilation queue,
//   3. while playing, search ANOTHER song and click it → the player SWITCHES
//      to it (the old track stops; it doesn't keep playing the previous one),
//   4. search by COMPILATION name → click → navigates to /c/:id,
//   5. search by AUTHOR name → click → navigates to /author/:slug.
//
// Chromium is launched with autoplay allowed so audio.play() resolves headless.
//
// Prerequisites: emulator suite running + seeded login user. Run with:
//   npm run test:e2e:player
//
// (In CI it runs inside `firebase emulators:exec` after seed + the other e2es.)

import { strict as assert } from 'node:assert';
import admin from 'firebase-admin';
import { chromium } from 'playwright';

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
process.env.FIREBASE_STORAGE_EMULATOR_HOST ||= '127.0.0.1:9199';
const PROJECT = process.env.GCLOUD_PROJECT || 'demo-compilator';
const HOSTING = process.env.HOSTING_URL || 'http://localhost:5050';
const EMAIL = 'peltier.nicolas@gmail.com';
const PASSWORD = 'password';

const AUTHOR = 'ptest-author@example.com';
const AUTHOR_NAME = 'Ptestcomposer';
const COMP1 = { id: 'ptestCompOne', title: 'PTEST Alpha Mix' };
const COMP2 = { id: 'ptestCompTwo', title: 'PTEST Beta Mix' };
// Distinct song + artist names so each search query matches exactly one result.
// The first song carries full enrichment so the detail screen has something to
// show (origin, Discogs links, bio, label, track no.).
const COMP1_SONGS = [
  {
    title: 'PTEST Song One',
    artist: 'Marin',
    enrichment: {
      year: 1978,
      label: 'PTEST Records',
      track: 4,
      artistTown: 'Brest',
      artistRegion: 'Bretagne',
      artistCountry: 'France',
      artistCountryCode: 'FR',
      artistBio: 'PTEST bio: un groupe imaginaire de Brest.',
      discogs: { artistId: 424242, releaseId: 999, releaseUrl: 'https://www.discogs.com/release/999' },
    },
  },
  { title: 'PTEST Song Two', artist: 'Lazare' },
  { title: 'PTEST Song Three', artist: 'Odette' },
];
const COMP2_SONGS = [{ title: 'PTEST Beta Track', artist: 'Sirius' }];

const step = (l) => console.log(`\n→ ${l}`);
const ok = (m) => console.log(`  ✓ ${m}`);

admin.initializeApp({ projectId: PROJECT, storageBucket: `${PROJECT}.appspot.com` });
const db = admin.firestore();
const bucket = admin.storage().bucket();
const FV = admin.firestore.FieldValue;

const uploadedPaths = [];

// Short mono WAV sine tone (distinct pitch per song).
function sineWav(freq, seconds = 2, sampleRate = 8000) {
  const n = Math.floor(seconds * sampleRate);
  const dataLen = n * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.2 * 32767), 44 + i * 2);
  return buf;
}

// Wait for enrichSongOnCreate to stamp enrichStatus (it always does, even when it
// skips or errors), then write the fixture fields so ours are the last word.
async function settleThenPatch(ref, fields) {
  for (let i = 0; i < 80; i++) {
    const snap = await ref.get();
    if (snap.exists && snap.data().enrichStatus) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await ref.set(fields, { merge: true });
}

async function seedComp(comp, songs, freqBase) {
  await db.collection('compilations').doc(comp.id).set({
    title: comp.title, author: AUTHOR, season: 'ete', year: 2025, status: 'published',
    trackCount: songs.length, totalDuration: songs.length * 2,
    createdAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp(),
  });
  let order = 1;
  for (const s of songs) {
    const storagePath = `store/ptest/${comp.id}-${order}.wav`;
    await bucket.file(storagePath).save(sineWav(freqBase + order * 40), {
      metadata: { contentType: 'audio/wav' }, resumable: false,
    });
    uploadedPaths.push(storagePath);
    const songRef = db.collection('compilations').doc(comp.id).collection('songs').doc(`${comp.id}_s${order}`);
    await songRef.set({
      title: s.title, artist: s.artist, album: comp.id, order, storagePath,
      duration: 2, addedAt: FV.serverTimestamp(),
    });
    // enrichSongOnCreate fires on that write and merges its own geo fields in —
    // nulls here, since the emulator has no Discogs token and MusicBrainz won't
    // know these made-up artists. It would clobber our fixture values, so wait
    // for the trigger to land before writing them.
    if (s.enrichment) await settleThenPatch(songRef, s.enrichment);
    order += 1;
  }
}

async function writeSeed() {
  await db.doc(`users/${AUTHOR}`).set({ displayName: AUTHOR_NAME, updatedAt: FV.serverTimestamp() });
  await seedComp(COMP1, COMP1_SONGS, 220);
  await seedComp(COMP2, COMP2_SONGS, 520);
}

async function removeSeed() {
  for (const id of [COMP1.id, COMP2.id]) {
    const ref = db.collection('compilations').doc(id);
    const songs = await ref.collection('songs').get();
    await Promise.all(songs.docs.map((s) => s.ref.delete()));
    await ref.delete().catch(() => {});
  }
  await db.doc(`users/${AUTHOR}`).delete().catch(() => {});
  await Promise.all(uploadedPaths.map((p) => bucket.file(p).delete().catch(() => {})));
}

const PAGE_HELPERS = `
  window.__searchHas = (group, title) => {
    const g = [...document.querySelectorAll('#searchResults .search-group')]
      .find((gr) => gr.querySelector('.search-group-label')?.textContent.trim() === group);
    if (!g) return false;
    return [...g.querySelectorAll('.si-title')].some((t) => t.textContent.trim() === title);
  };
  window.__clickSearchResult = (group, title) => {
    const g = [...document.querySelectorAll('#searchResults .search-group')]
      .find((gr) => gr.querySelector('.search-group-label')?.textContent.trim() === group);
    if (!g) return false;
    const item = [...g.querySelectorAll('.search-item')]
      .find((it) => it.querySelector('.si-title')?.textContent.trim() === title);
    if (!item) return false;
    item.click();
    return true;
  };
`;

async function run() {
  step('seed compilations + songs with real WAV audio');
  await removeSeed();
  await writeSeed();
  ok(`seeded ${COMP1.title} (3 songs) + ${COMP2.title} (1 song), author ${AUTHOR_NAME}`);

  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newContext({ viewport: { width: 1100, height: 900 } }).then((c) => c.newPage());
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // Search helpers.
  const search = async (query, group, title) => {
    await page.fill('#searchInput', query);
    await page.waitForFunction(([g, t]) => window.__searchHas(g, t), [group, title], { timeout: 20000 });
  };
  const clickResult = async (group, title) => {
    const hit = await page.evaluate(([g, t]) => window.__clickSearchResult(g, t), [group, title]);
    assert.ok(hit, `search result "${title}" (${group}) not found`);
  };
  // Player state helpers.
  const title = () => page.$eval('#pb-title', (e) => e.textContent.trim()).catch(() => null);
  const playGlyph = () => page.$eval('#pb-play', (e) => e.textContent.trim());
  const waitTitle = (t) => page.waitForFunction((x) => document.querySelector('#pb-title')?.textContent.trim() === x, t, { timeout: 20000 });
  const waitPlaying = () => page.waitForFunction(() => document.querySelector('#pb-play')?.textContent.trim() === '⏸', null, { timeout: 20000 });
  const waitPaused = () => page.waitForFunction(() => document.querySelector('#pb-play')?.textContent.trim() === '▶', null, { timeout: 20000 });

  try {
    step('log in');
    await page.goto(`${HOSTING}/login.html`);
    await page.fill('#email', EMAIL);
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL((u) => !u.pathname.includes('login'), { timeout: 20000 });
    // #searchInput is static in index.html, so it exists before app.js finishes
    // booting and wiring initSearch(). Wait for the home view to mount (#shuffleRow
    // renders only after boot) so search listeners are attached before we type.
    await page.waitForSelector('#searchInput', { timeout: 20000 });
    await page.waitForSelector('#shuffleRow', { timeout: 20000 });
    await page.addScriptTag({ content: PAGE_HELPERS });
    ok('logged in, app booted, search box wired');

    step('search by SONG name → click → that track plays');
    await search('PTEST Song One', 'Morceaux', 'PTEST Song One');
    await clickResult('Morceaux', 'PTEST Song One');
    await waitTitle('PTEST Song One');
    await waitPlaying();
    assert.equal(await page.$eval('body', (b) => b.classList.contains('has-player')), true, 'has-player after play');
    ok('clicked "PTEST Song One" → playing (⏸)');

    step('play / pause toggle');
    await page.click('#pb-play');
    await waitPaused();
    ok('pause works (▶)');
    await page.click('#pb-play');
    await waitPlaying();
    ok('resume works (⏸)');

    step('next / prev step through the compilation queue (from the expanded view)');
    // Transport (prev/next) now lives in the expanded view; clicking the
    // floating bar (here via the title, not the play button) opens it.
    await page.click('#pb-title');
    await page.waitForSelector('.player-full:not([hidden]) #pf-next', { timeout: 20000 });
    await page.click('#pf-next');
    await waitTitle('PTEST Song Two');
    ok('next → "PTEST Song Two"');
    await page.click('#pf-prev');
    await waitTitle('PTEST Song One');
    ok('prev → "PTEST Song One"');

    step('detail screen (2nd screen) is reachable at desktop width and shows artist + track detail');
    // This viewport is desktop-width: the second screen used to be phone-only.
    await page.click('#pf-next-screen');
    await page.waitForSelector('.player-full:not([hidden]) .pfd', { timeout: 20000 });
    const detail = await page.textContent('#pf-meta');
    for (const expected of [
      'Marin',                                    // artist name
      'Brest, Bretagne, France',                  // origin, town → region → country
      'PTEST bio: un groupe imaginaire de Brest.',// bio in full
      'PTEST Records',                            // label
      'PTEST Alpha Mix',                          // the compilation it came from
      '1978',                                     // year
    ]) {
      assert.ok(detail.includes(expected), `detail screen should mention "${expected}", got: ${detail}`);
    }
    const artistHref = await page.getAttribute('#pf-meta a[href*="/artist/424242"]', 'href');
    assert.ok(artistHref, 'detail screen should link to the Discogs ARTIST page');
    assert.ok(
      await page.getAttribute('#pf-meta a[href*="/release/999"]', 'href'),
      'detail screen should link to the Discogs RELEASE page',
    );
    ok('detail screen shows origin, bio, label, compilation + both Discogs links');

    // Switching track repaints the panel for the new song (guarded by pfMetaSongId).
    // The transport lives on screen 1, which is translated out of the viewport
    // while screen 2 is showing — so step back before using it.
    await page.click('#pf-prev-screen');
    await page.click('#pf-next');
    await waitTitle('PTEST Song Two');
    await page.click('#pf-next-screen');
    await page.waitForFunction(
      () => !document.querySelector('#pf-meta')?.textContent.includes('PTEST bio'),
      { timeout: 20000 },
    );
    ok('detail screen repaints on track change (Song Two has no enrichment)');

    // Back to screen 1 / Song One so the remaining steps start where they used to.
    await page.click('#pf-prev-screen');
    await page.click('#pf-prev');
    await waitTitle('PTEST Song One');
    await page.click('#pf-min'); // collapse back to the bar
    await page.waitForSelector('.player-full', { state: 'hidden', timeout: 20000 });

    step('while playing, search ANOTHER song and click it → player SWITCHES');
    const before = await title();
    assert.equal(before, 'PTEST Song One', `precondition: should be on Song One, got "${before}"`);
    await search('PTEST Song Three', 'Morceaux', 'PTEST Song Three');
    await clickResult('Morceaux', 'PTEST Song Three');
    await waitTitle('PTEST Song Three');     // the bug was: title/queue updated but old kept playing
    await waitPlaying();                      // ...and the new one never started
    assert.notEqual(await title(), before, 'player should have switched off the previous track');
    ok('switched to "PTEST Song Three" and it is playing');

    step('search by COMPILATION name → click → navigates to the compilation');
    await search('PTEST Beta Mix', 'Compilations', 'PTEST Beta Mix');
    await clickResult('Compilations', 'PTEST Beta Mix');
    await page.waitForURL((u) => u.pathname === `/c/${COMP2.id}`, { timeout: 20000 });
    ok(`navigated to /c/${COMP2.id}`);

    step('search by AUTHOR name → click → navigates to the author page');
    await search(AUTHOR_NAME, 'Auteurs', AUTHOR_NAME);
    await clickResult('Auteurs', AUTHOR_NAME);
    await page.waitForURL((u) => u.pathname.startsWith('/author/'), { timeout: 20000 });
    ok(`navigated to ${new URL(page.url()).pathname}`);

    assert.deepEqual(pageErrors, [], `unexpected page errors: ${JSON.stringify(pageErrors)}`);
  } finally {
    await browser.close();
    await removeSeed();
  }
}

run()
  .then(() => { console.log('\n✅ player e2e passed'); process.exit(0); })
  .catch((err) => { console.error('\n❌ player e2e FAILED\n', err); process.exit(1); });
