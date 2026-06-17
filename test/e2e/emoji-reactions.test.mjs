// Browser end-to-end test for the multi-emoji reaction system + emoji filter.
// Drives the real client code (reactions.js, community-reactions.js,
// reaction-control.js, views/compilation.js, views/player.js, views/home.js,
// views/profile.js) in Chromium against the emulator.
//
// Covers: the "+" picker (add/remove, multi-emoji), per-doc persistence and
// deletion-when-empty, legacy {value:'like'} back-compat, the COMMUNITY
// aggregate (counts across users + .mine marker + hover attribution), player-bar
// reactions with live row↔bar sync, the removed preset shuffle buttons, and the
// emoji filter (want chip, count, want→don't-want cycling, deterministic
// playback), plus the profile "Mes coups de cœur" list.
//
// Prerequisites: emulator suite running (npm run dev) + allowlisted login user.

import { strict as assert } from 'node:assert';
import admin from 'firebase-admin';
import { chromium } from 'playwright';

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
process.env.FIREBASE_STORAGE_EMULATOR_HOST ||= '127.0.0.1:9199';
const PROJECT = process.env.GCLOUD_PROJECT || 'demo-compilator';
const HOSTING = process.env.HOSTING_URL || 'http://localhost:5050';
const EMAIL = 'peltier.nicolas@gmail.com';
const PASSWORD = 'password';

const AUTHOR = 'rxtest-author@example.com';
const FAN = 'rxtest-fan@example.com';
const FAN_NAME = 'RXFan';
const COMP = { id: 'rxtestComp', title: 'RXTEST Mix' };
const SONGS = [
  { id: 'rxtestComp_s1', title: 'RXTEST Song One', artist: 'Marin' },
  { id: 'rxtestComp_s2', title: 'RXTEST Song Two', artist: 'Lazare' },
];

const step = (l) => console.log(`\n→ ${l}`);
const ok = (m) => console.log(`  ✓ ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

admin.initializeApp({ projectId: PROJECT, storageBucket: `${PROJECT}.appspot.com` });
const db = admin.firestore();
const bucket = admin.storage().bucket();
const FV = admin.firestore.FieldValue;
const uploaded = [];

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

async function writeSeed() {
  await db.doc(`users/${AUTHOR}`).set({ displayName: 'RXComposer', updatedAt: FV.serverTimestamp() });
  await db.doc(`users/${FAN}`).set({ displayName: FAN_NAME, updatedAt: FV.serverTimestamp() });
  await db.collection('compilations').doc(COMP.id).set({
    title: COMP.title, author: AUTHOR, season: 'ete', year: 2025, status: 'published',
    trackCount: SONGS.length, totalDuration: SONGS.length * 2, createdAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp(),
  });
  let order = 1;
  for (const s of SONGS) {
    const storagePath = `store/rxtest/${s.id}.wav`;
    await bucket.file(storagePath).save(sineWav(220 + order * 60), { metadata: { contentType: 'audio/wav' }, resumable: false });
    uploaded.push(storagePath);
    await db.collection('compilations').doc(COMP.id).collection('songs').doc(s.id).set({
      title: s.title, artist: s.artist, order, storagePath, duration: 2, addedAt: FV.serverTimestamp(),
    });
    order += 1;
  }
  // Back-compat: a LEGACY {value:'like'} reaction on song 2 by the login user.
  await db.doc(`users/${EMAIL}/reactions/${SONGS[1].id}`).set({ value: 'like', at: FV.serverTimestamp() });
  // Community: a SECOND user reacts to song 1 with ❤️ and 😂.
  await db.doc(`users/${FAN}/reactions/${SONGS[0].id}`).set({ emojis: ['❤️', '😂'], at: FV.serverTimestamp() });
}

async function removeSeed() {
  const ref = db.collection('compilations').doc(COMP.id);
  const songs = await ref.collection('songs').get();
  await Promise.all(songs.docs.map((s) => s.ref.delete()));
  await ref.delete().catch(() => {});
  await db.doc(`users/${AUTHOR}`).delete().catch(() => {});
  await db.doc(`users/${FAN}`).delete().catch(() => {});
  await db.doc(`users/${FAN}/reactions/${SONGS[0].id}`).delete().catch(() => {});
  for (const s of SONGS) await db.doc(`users/${EMAIL}/reactions/${s.id}`).delete().catch(() => {});
  await Promise.all(uploaded.map((p) => bucket.file(p).delete().catch(() => {})));
}

const row = (sid) => `li[data-song-id="${sid}"]`;

async function run() {
  step('seed: 2 songs (real WAV), legacy like on song2, a 2nd user reacting to song1');
  await removeSeed();
  await writeSeed();
  ok('seeded');

  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newContext({ viewport: { width: 1100, height: 900 } }).then((c) => c.newPage());
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // Read a strip as {emoji: countText|null} for a given row/host selector.
  const strip = (hostSel) => page.evaluate((sel) => {
    const out = {};
    for (const chip of document.querySelectorAll(`${sel} .rx-strip .rx-chip`)) {
      const emoji = chip.querySelector('.rx-emo')?.textContent;
      const count = chip.querySelector('.rx-count')?.textContent || null;
      if (emoji) out[emoji] = { count, mine: chip.classList.contains('mine'), title: chip.title };
    }
    return out;
  }, hostSel);
  // Click an emoji in the palette currently open under hostSel.
  const pick = async (hostSel, emoji) => {
    const hit = await page.evaluate(([sel, e]) => {
      const o = [...document.querySelectorAll(`${sel} .rx-palette .rx-opt`)].find((b) => b.textContent === e);
      if (!o) return false; o.click(); return true;
    }, [hostSel, emoji]);
    assert.ok(hit, `palette option ${emoji} not found under ${hostSel}`);
  };
  const openPicker = async (hostSel) => {
    await page.click(`${hostSel} .rx-add`);
    await page.waitForSelector(`${hostSel} .rx-palette`, { timeout: 5000 });
  };
  const docEmojis = async (sid) => {
    const d = await db.doc(`users/${EMAIL}/reactions/${sid}`).get();
    return d.exists ? d.data().emojis : null;
  };
  const waitDoc = async (sid, pred) => {
    for (let i = 0; i < 24; i++) { const e = await docEmojis(sid); if (pred(e)) return e; await sleep(250); }
    return docEmojis(sid).then((e) => { throw new Error(`doc ${sid} never matched; last=${JSON.stringify(e)}`); });
  };

  try {
    step('log in');
    await page.goto(`${HOSTING}/login.html`);
    await page.fill('#email', EMAIL);
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL((u) => !u.pathname.includes('login'), { timeout: 20000 });
    await page.waitForSelector('#shuffleRow', { timeout: 20000 });
    ok('logged in');

    step('compilation view renders the new control; old like/dislike buttons gone');
    await page.goto(`${HOSTING}/c/${COMP.id}`);
    await page.waitForSelector(`${row(SONGS[0].id)} .rx-add`, { timeout: 20000 });
    assert.equal(await page.$(`${row(SONGS[0].id)} .rx-like`), null, 'old .rx-like present');
    assert.equal(await page.$('.tk-react'), null, 'old .tk-react cell present');
    ok('new "+" control on every row, no legacy buttons');

    step('back-compat: legacy {value:"like"} renders as ❤️ on song2');
    await page.waitForFunction((sel) => document.querySelector(`${sel} .rx-strip .rx-chip`), row(SONGS[1].id), { timeout: 20000 });
    assert.ok((await strip(row(SONGS[1].id)))['❤️'], 'song2 missing ❤️');
    ok('song2 shows ❤️ from the legacy doc');

    step('community aggregate: 2nd user’s ❤️/😂 show on song1 with attribution');
    await page.waitForFunction((sel) => Object.keys(
      [...document.querySelectorAll(`${sel} .rx-strip .rx-emo`)].map((e) => e.textContent),
    ).length >= 2, row(SONGS[0].id), { timeout: 20000 });
    let s1 = await strip(row(SONGS[0].id));
    assert.ok(s1['❤️'] && s1['😂'], 'song1 missing community ❤️/😂');
    assert.equal(s1['❤️'].count, null, '❤️ should have no count number at 1 user');
    assert.ok(s1['❤️'].title.includes(FAN_NAME), `❤️ attribution missing ${FAN_NAME} (got "${s1['❤️'].title}")`);
    assert.equal(s1['❤️'].mine, false, '❤️ should not be .mine yet');
    ok(`song1 shows ❤️ + 😂 from ${FAN_NAME} (hover attribution present)`);

    step('I add ❤️ to song1 → count becomes 2 and the chip is .mine');
    await openPicker(row(SONGS[0].id));
    await pick(row(SONGS[0].id), '❤️');
    await page.waitForFunction((sel) => {
      const c = [...document.querySelectorAll(`${sel} .rx-strip .rx-chip`)].find((ch) => ch.querySelector('.rx-emo')?.textContent === '❤️');
      return c && c.querySelector('.rx-count')?.textContent === '2' && c.classList.contains('mine');
    }, row(SONGS[0].id), { timeout: 5000 });
    s1 = await strip(row(SONGS[0].id));
    assert.ok(s1['❤️'].title.includes(FAN_NAME), 'attribution should still list the other user');
    ok('song1 ❤️ count = 2, marked .mine, attribution lists both');

    step('I add 🔥 to song1 → doc persists [❤️,🔥]');
    await pick(row(SONGS[0].id), '🔥');
    let e1 = await waitDoc(SONGS[0].id, (e) => Array.isArray(e) && e.includes('❤️') && e.includes('🔥'));
    ok(`persisted ${JSON.stringify(e1)}`);

    step('player bar shows a reaction control; reacting there syncs to the row live');
    await page.click(`${row(SONGS[0].id)} .title`); // play song1
    await page.waitForFunction(() => document.querySelector('#pb-react .rx-add'), null, { timeout: 20000 });
    await page.waitForFunction(() => [...document.querySelectorAll('#pb-react .rx-strip .rx-emo')].some((e) => e.textContent === '🔥'), null, { timeout: 5000 });
    await openPicker('#pb-react');
    await pick('#pb-react', '🎉');
    await waitDoc(SONGS[0].id, (e) => Array.isArray(e) && e.includes('🎉'));
    await page.waitForFunction((sel) => [...document.querySelectorAll(`${sel} .rx-strip .rx-emo`)].some((e) => e.textContent === '🎉'), row(SONGS[0].id), { timeout: 5000 });
    ok('🎉 added from the player bar appears on the row too (live sync)');

    step('removing every emoji from song1 deletes the per-user doc');
    await openPicker(row(SONGS[0].id));
    for (const e of ['❤️', '🔥', '🎉']) await pick(row(SONGS[0].id), e);
    for (let i = 0; i < 24; i++) { if (!(await db.doc(`users/${EMAIL}/reactions/${SONGS[0].id}`).get()).exists) break; await sleep(250); }
    assert.equal((await db.doc(`users/${EMAIL}/reactions/${SONGS[0].id}`).get()).exists, false, 'doc not deleted when emptied');
    // community ❤️ from the other user must remain (count back to 1, no number)
    s1 = await strip(row(SONGS[0].id));
    assert.ok(s1['❤️'] && s1['❤️'].count === null && !s1['❤️'].mine, 'other user’s ❤️ should remain after I clear mine');
    ok('doc deleted; the other user’s ❤️ still shows');

    step('home: preset buttons removed; emoji filter want ❤️ → count');
    // Deterministic tags for the filter: song1=[❤️,🔥], song2=[❤️]. Reload picks them up.
    await db.doc(`users/${EMAIL}/reactions/${SONGS[0].id}`).set({ emojis: ['❤️', '🔥'], at: FV.serverTimestamp() });
    await db.doc(`users/${EMAIL}/reactions/${SONGS[1].id}`).set({ emojis: ['❤️'], at: FV.serverTimestamp() });
    await page.goto(`${HOSTING}/`);
    await page.waitForSelector('#shuffleRow', { timeout: 20000 });
    assert.equal(await page.$('#sh-clean'), null, '"Tout sauf les 😬" button still present');
    assert.equal(await page.$('#sh-liked'), null, '"Mes coups de cœur" button still present');
    assert.ok(await page.$('#sh-all'), '"Tout en aléatoire" button missing');
    await page.click('#filterToggle');
    await page.waitForSelector('#emojiFilterChips .rx-filter-add', { timeout: 5000 });
    await page.click('#emojiFilterChips .rx-filter-add');
    await page.waitForSelector('#emojiFilterRow .rx-palette', { timeout: 5000 });
    await pick('#emojiFilterRow', '❤️');
    await page.waitForFunction(() => /· 2 morceaux/.test(document.querySelector('#sh-selection')?.textContent || ''), null, { timeout: 5000 });
    ok(`want ❤️ → "${(await page.$eval('#sh-selection', (e) => e.textContent)).trim()}"`);

    step('cycle ❤️… no — add 🔥 to want then demote it to don’t-want → count drops to 1');
    await pick('#emojiFilterRow', '🔥'); // adds 🔥 to want
    // demote the 🔥 want-chip to don't-want by clicking it
    await page.waitForFunction(() => [...document.querySelectorAll('#emojiFilterChips .emoji-chip')].some((c) => c.textContent.includes('🔥')), null, { timeout: 5000 });
    await page.evaluate(() => {
      const c = [...document.querySelectorAll('#emojiFilterChips .emoji-chip')].find((x) => x.textContent.includes('🔥') && !x.classList.contains('dont'));
      c?.click();
    });
    await page.waitForFunction(() => {
      const hasSep = !!document.querySelector('#emojiFilterChips .emoji-filter-sep');
      const hasDont = !!document.querySelector('#emojiFilterChips .emoji-chip.dont');
      const one = /· 1 morceau\b/.test(document.querySelector('#sh-selection')?.textContent || '');
      return hasSep && hasDont && one;
    }, null, { timeout: 5000 });
    ok('filter shows "❤️ − 🔥" and count drops to 1 morceau');

    step('"Lire la sélection" plays exactly the matching song (song2)');
    await page.click('#sh-selection');
    await page.waitForFunction((t) => document.querySelector('#pb-title')?.textContent.trim() === t, SONGS[1].title, { timeout: 20000 });
    ok(`playing "${SONGS[1].title}" (song1 excluded by don’t-want 🔥)`);

    step('profile "Mes coups de cœur" lists my ❤️-tagged songs');
    await page.goto(`${HOSTING}/profile`);
    await page.waitForSelector('#likes li', { timeout: 20000 });
    const liked = await page.$$eval('#likes li .title', (els) => els.map((e) => e.textContent.trim()));
    assert.ok(liked.includes(SONGS[0].title) && liked.includes(SONGS[1].title), `likes list missing songs: ${JSON.stringify(liked)}`);
    ok(`favorites list: ${JSON.stringify(liked)}`);

    assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join(' | ')}`);
    console.log('\n✅ emoji-reactions e2e passed');
  } finally {
    await browser.close();
    await removeSeed();
  }
}

run().catch((e) => { console.error('\n❌', e); process.exit(1); });
