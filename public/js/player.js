// Persistent in-app audio player.
//
// One <audio> element, one bar, lives in the shell document for the entire
// session. Survives in-app SPA navigation as long as the parent page isn't
// reloaded. On cold reload it restores from sessionStorage (audio re-buffers).
//
// Public API:
//   initPlayer()                                 — render the bar; restore session
//   playQueue(tracks, { startIndex, shuffle, sourceLabel })
//   playAt(idx)
//   stop()
//   getCurrentTrack()

import { storage } from './firebase-init.js';
import {
  ref as storageRef,
  getDownloadURL,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-storage.js';
import { ensureCommunityReactionsLoaded } from './community-reactions.js';
import { createReactionControl } from './reaction-control.js';
import { coverUrl } from './image-url.js';
import { navigate } from './router.js';
import { ensureSongsLoaded, getSong } from './catalog.js';
import { doublonChipsHTML, enrichFactsHTML, paintDoublonCovers } from './track-meta.js';

const SESSION_KEY = 'compilator.player.v1';
const VOLUME_KEY = 'compilator.volume.v1'; // persists across sessions (localStorage)

const audio = new Audio();
audio.preload = 'metadata';
// Restore the last chosen volume before anything plays. Note: iOS Safari treats
// `audio.volume` as read-only (hardware buttons own it) — the stored level is a
// no-op there, but `muted` still works, so mute survives everywhere.
try {
  const v = JSON.parse(localStorage.getItem(VOLUME_KEY) || 'null');
  if (v && typeof v.volume === 'number') { audio.volume = v.volume; audio.muted = !!v.muted; }
} catch (_) { /* ignore corrupt value */ }

let queue = [];
let cursor = -1;
let sourceLabel = '';
let userPaused = false;   // the user's intent: true only after an explicit pause
let switching = false;    // true mid-track-swap, so auto-resume doesn't fight playAt()
let skippedInARow = 0; // consecutive unavailable tracks — guards an all-missing queue
let bar;
const audioUrlCache = new Map(); // storagePath → resolved download URL (per-session)

// Resolve a song's download URL, caching forever. Firebase download URLs embed
// a stable token, so the same path always returns the same URL within a session.
async function resolveAudioUrl(storagePath) {
  if (!storagePath) return null;
  if (audioUrlCache.has(storagePath)) return audioUrlCache.get(storagePath);
  const url = await getDownloadURL(storageRef(storage, storagePath));
  audioUrlCache.set(storagePath, url);
  return url;
}

// Kick off URL resolution for the next few tracks in the queue so their src is
// ready to swap synchronously on `ended`. Critical on mobile: when the screen
// locks and the page goes to background, network fetches inside the `ended`
// handler are throttled / deferred, which would otherwise stall the queue.
// We look ahead a few tracks so auto-advance can chain across several songs
// even if no subsequent prefetch ever lands while backgrounded.
const PREFETCH_LOOKAHEAD = 3;
function prefetchAhead() {
  for (let i = 1; i <= PREFETCH_LOOKAHEAD; i++) {
    const t = queue[cursor + i];
    if (t?.storagePath) resolveAudioUrl(t.storagePath).catch(() => {});
  }
}

function fmt(s) {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${r.toString().padStart(2, '0')}`;
}

function shuffleArr(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function initPlayer() {
  if (bar) return;
  bar = document.createElement('div');
  bar.className = 'player-bar';
  bar.hidden = true;
  bar.innerHTML = `
    <div class="pb-left">
      <div class="pb-cover" id="pb-cover" title="Aller à la compilation"></div>
      <div class="now">
        <div class="t" id="pb-title">—</div>
        <div class="a" id="pb-artist"></div>
        <div class="src" id="pb-source"></div>
      </div>
    </div>
    <div class="controls">
      <button class="icon" id="pb-prev" title="Précédent" aria-label="Précédent">⏮</button>
      <button class="icon" id="pb-play" title="Lecture / pause" aria-label="Lecture / pause">▶</button>
      <button class="icon" id="pb-next" title="Suivant" aria-label="Suivant">⏭</button>
      <span class="time" id="pb-cur">0:00</span>
      <div class="scrub"><input type="range" id="pb-scrub" min="0" max="1000" value="0" step="1"></div>
      <span class="time" id="pb-tot">0:00</span>
    </div>
    <div class="pb-right">
      <div class="rx-host" id="pb-react"></div>
      <span class="pb-sep" aria-hidden="true"></span>
      <div class="pb-volume">
        <button class="icon" id="pb-mute" title="Couper le son" aria-label="Couper le son">🔊</button>
        <input type="range" id="pb-vol" class="vol" min="0" max="100" value="100" step="1" aria-label="Volume">
      </div>
      <button class="icon" id="pb-expand" title="Plein écran" aria-label="Plein écran">⤢</button>
      <button class="btn-ghost" id="pb-stop">Arrêter</button>
    </div>
  `;
  document.body.appendChild(bar);
  buildFullscreen();

  bar.querySelector('#pb-play').addEventListener('click', () => {
    if (audio.paused) { userPaused = false; audio.play().catch(() => {}); }
    else { userPaused = true; audio.pause(); }
  });
  bar.querySelector('#pb-prev').addEventListener('click', () => playAt(cursor - 1));
  bar.querySelector('#pb-next').addEventListener('click', () => playAt(cursor + 1));
  bar.querySelector('#pb-stop').addEventListener('click', stop);
  bar.querySelector('#pb-expand').addEventListener('click', openFullscreen);
  bar.querySelector('#pb-cover').addEventListener('click', () => {
    const t = queue[cursor];
    if (t?.compilationId) navigate(`/c/${t.compilationId}`);
  });
  const scrub = bar.querySelector('#pb-scrub');
  scrub.addEventListener('input', () => {
    if (audio.duration) audio.currentTime = (scrub.value / 1000) * audio.duration;
  });
  bar.querySelector('#pb-vol').addEventListener('input', (e) => setVolume(Number(e.target.value)));
  bar.querySelector('#pb-mute').addEventListener('click', toggleMute);
  audio.addEventListener('timeupdate', () => {
    const d = audio.duration || 0;
    const pos = d ? Math.round((audio.currentTime / d) * 1000) : 0;
    scrub.value = pos;
    bar.querySelector('#pb-cur').textContent = fmt(audio.currentTime);
    bar.querySelector('#pb-tot').textContent = fmt(d);
    syncFullscreenTime(pos, audio.currentTime, d);
    updatePositionState();
    persistThrottled();
  });
  audio.addEventListener('play', () => { userPaused = false; setPlayIcon('⏸'); setPlaybackState('playing'); persist(); });
  audio.addEventListener('pause', () => {
    setPlayIcon('▶');
    setPlaybackState('paused');
    persist();
    // A pause we didn't ask for (incoming call, another app grabbing audio
    // focus, notification ducking) — try to pick playback back up.
    resumeIfInterrupted();
  });
  audio.addEventListener('volumechange', syncVolumeUI);
  // Recover from transient buffer stalls (common on mobile radios) without
  // waiting for the user — the queue prefetch usually has data ready.
  audio.addEventListener('stalled', () => { if (!userPaused && !switching) audio.play().catch(() => {}); });
  // Resume once the interruption clears: the app regains focus / visibility
  // when the user returns from a call, or the OS sends a media-key `play`.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) resumeIfInterrupted(); });
  window.addEventListener('focus', resumeIfInterrupted);
  audio.addEventListener('ended', () => playAt(cursor + 1));

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && fsOpen) { closeFullscreen(); return; }
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (audio.paused) { userPaused = false; audio.play().catch(() => {}); }
      else { userPaused = true; audio.pause(); }
    }
  });

  setupMediaSession();
  syncVolumeUI();
  restoreSession();
}

// ---- volume ----
// Level lives on the shared `audio` element; two UIs (bar + fullscreen) mirror
// it. `muted` is kept independent of the slider position so un-muting returns
// to the previous level (and so a mute survives on iOS, where level is fixed).
function volGlyph() {
  if (audio.muted || audio.volume === 0) return '🔇';
  if (audio.volume < 0.34) return '🔈';
  if (audio.volume < 0.67) return '🔉';
  return '🔊';
}
function syncVolumeUI() {
  const pct = Math.round(audio.volume * 100);
  for (const id of ['pb-vol', 'pf-vol']) {
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) el.value = pct;
  }
  for (const id of ['pb-mute', 'pf-mute']) {
    const el = document.getElementById(id);
    if (el) el.textContent = volGlyph();
  }
}
function setVolume(pct) {
  audio.volume = Math.max(0, Math.min(1, pct / 100));
  if (audio.volume > 0 && audio.muted) audio.muted = false; // dragging up un-mutes
  saveVolume();
  syncVolumeUI();
}
function toggleMute() {
  audio.muted = !audio.muted;
  saveVolume();
  syncVolumeUI();
}
function saveVolume() {
  try { localStorage.setItem(VOLUME_KEY, JSON.stringify({ volume: audio.volume, muted: audio.muted })); } catch (_) { /* ignore */ }
}

// ---- interruption recovery ----
// Resume playback after a pause we didn't initiate (phone call, audio-focus
// steal, radio hiccup). Event-driven only — called from discrete signals
// (the `pause`/`stalled` events, regained focus/visibility, the OS play key),
// never polled — so a genuinely-unresumable state simply waits for the next
// signal instead of spinning. Guarded against the mid-swap `pause()` in playAt.
function resumeIfInterrupted() {
  if (userPaused || switching || cursor < 0 || !audio.src || audio.ended || !audio.paused) return;
  audio.play().catch(() => {});
}

// The bar shows one reaction control, rebuilt when the current track changes.
let rxControl = null;
let rxSongId = null;

function renderReactionControl() {
  const host = bar.querySelector('#pb-react');
  if (!host) return;
  const t = queue[cursor];
  if (!t?.songId) {
    if (rxControl) { rxControl.unsub(); rxControl = null; rxSongId = null; }
    host.innerHTML = '';
    return;
  }
  if (rxControl && rxSongId === t.songId) { rxControl.refresh(); return; }
  if (rxControl) rxControl.unsub();
  host.innerHTML = '';
  rxControl = createReactionControl(t.songId, { compact: true });
  rxSongId = t.songId;
  host.appendChild(rxControl.el);
  ensureCommunityReactionsLoaded().then(() => { if (rxSongId === t.songId) rxControl?.refresh(); });
}

async function applyCover(track) {
  const cover = bar.querySelector('#pb-cover');
  cover.style.backgroundImage = '';
  cover.textContent = '';
  if (!track?.coverPath) {
    cover.classList.add('placeholder');
    cover.textContent = (track?.compilationTitle || track?.title || '?')[0]?.toUpperCase() || '?';
    return;
  }
  cover.classList.remove('placeholder');
  const url = await coverUrl(track.coverPath);
  // Only apply if we're still on the same track.
  if (url && queue[cursor]?.coverPath === track.coverPath) {
    cover.style.backgroundImage = `url(${url})`;
  }
}

// ---- full-screen overlay ----
// An immersive view over the current track, sharing the same `audio`/`queue`
// state as the bar. Screen 1: cover, title, artist, reactions, transport.
// Screen 2: Discogs facts/link, artist bio, duplicate compilations.
let fsEl = null;
let fsOpen = false;
let fsScreen = 0; // 0 = cover, 1 = details
let pfRxControl = null;
let pfRxSongId = null;
let pfMetaSongId = null; // guards async screen-2 render against track changes
let touchStartX = null;

// Update the play/pause glyph on both the bar and the overlay.
function setPlayIcon(txt) {
  const barBtn = bar?.querySelector('#pb-play');
  if (barBtn) barBtn.textContent = txt;
  const fsBtn = fsEl?.querySelector('#pf-play');
  if (fsBtn) fsBtn.textContent = txt;
}

function syncFullscreenTime(pos, cur, dur) {
  if (!fsOpen) return;
  const scrub = fsEl.querySelector('#pf-scrub');
  if (scrub && document.activeElement !== scrub) scrub.value = pos;
  fsEl.querySelector('#pf-cur').textContent = fmt(cur);
  fsEl.querySelector('#pf-tot').textContent = fmt(dur);
}

function buildFullscreen() {
  if (fsEl) return;
  fsEl = document.createElement('div');
  fsEl.className = 'player-full';
  fsEl.hidden = true;
  fsEl.innerHTML = `
    <button class="pf-min icon" id="pf-min" title="Réduire" aria-label="Réduire">⌄</button>
    <button class="pf-arrow pf-arrow-prev icon" id="pf-prev-screen" aria-label="Écran précédent">‹</button>
    <button class="pf-arrow pf-arrow-next icon" id="pf-next-screen" aria-label="Écran suivant">›</button>
    <div class="pf-viewport">
      <div class="pf-track" id="pf-strack">
        <section class="pf-screen pf-screen-1">
          <div class="pf-cover" id="pf-cover"></div>
          <div class="pf-now">
            <div class="pf-title" id="pf-title">—</div>
            <div class="pf-artist" id="pf-artist"></div>
          </div>
          <div class="pf-react rx-host" id="pf-react"></div>
          <div class="pf-controls">
            <button class="icon" id="pf-prev" title="Précédent" aria-label="Précédent">⏮</button>
            <button class="icon" id="pf-play" title="Lecture / pause" aria-label="Lecture / pause">▶</button>
            <button class="icon" id="pf-next" title="Suivant" aria-label="Suivant">⏭</button>
          </div>
          <div class="pf-scrubrow">
            <span class="time" id="pf-cur">0:00</span>
            <div class="scrub"><input type="range" id="pf-scrub" min="0" max="1000" value="0" step="1"></div>
            <span class="time" id="pf-tot">0:00</span>
          </div>
          <div class="pf-volrow">
            <button class="icon" id="pf-mute" title="Couper le son" aria-label="Couper le son">🔊</button>
            <input type="range" id="pf-vol" class="vol" min="0" max="100" value="100" step="1" aria-label="Volume">
          </div>
        </section>
        <section class="pf-screen pf-screen-2">
          <div class="pf-meta" id="pf-meta"></div>
        </section>
      </div>
    </div>
    <div class="pf-dots">
      <button class="pf-dot" data-screen="0" aria-label="Écran 1"></button>
      <button class="pf-dot" data-screen="1" aria-label="Écran 2"></button>
    </div>
  `;
  document.body.appendChild(fsEl);

  fsEl.querySelector('#pf-min').addEventListener('click', closeFullscreen);
  fsEl.querySelector('#pf-prev-screen').addEventListener('click', () => goScreen(fsScreen - 1));
  fsEl.querySelector('#pf-next-screen').addEventListener('click', () => goScreen(fsScreen + 1));
  fsEl.querySelectorAll('.pf-dot').forEach((d) => d.addEventListener('click', () => goScreen(Number(d.dataset.screen))));

  fsEl.querySelector('#pf-play').addEventListener('click', () => {
    if (audio.paused) { userPaused = false; audio.play().catch(() => {}); }
    else { userPaused = true; audio.pause(); }
  });
  fsEl.querySelector('#pf-prev').addEventListener('click', () => playAt(cursor - 1));
  fsEl.querySelector('#pf-next').addEventListener('click', () => playAt(cursor + 1));
  const pfScrub = fsEl.querySelector('#pf-scrub');
  pfScrub.addEventListener('input', () => {
    if (audio.duration) audio.currentTime = (pfScrub.value / 1000) * audio.duration;
  });
  fsEl.querySelector('#pf-vol').addEventListener('input', (e) => setVolume(Number(e.target.value)));
  fsEl.querySelector('#pf-mute').addEventListener('click', toggleMute);
  // Cover tap → jump to the compilation (and close), mirroring the bar cover.
  fsEl.querySelector('#pf-cover').addEventListener('click', () => {
    const t = queue[cursor];
    if (t?.compilationId) { closeFullscreen(); navigate(`/c/${t.compilationId}`); }
  });

  // Horizontal swipe between screens.
  const vp = fsEl.querySelector('.pf-viewport');
  vp.addEventListener('touchstart', (e) => { touchStartX = e.touches[0].clientX; }, { passive: true });
  vp.addEventListener('touchend', (e) => {
    if (touchStartX == null) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    touchStartX = null;
    if (Math.abs(dx) < 50) return;
    goScreen(fsScreen + (dx < 0 ? 1 : -1));
  }, { passive: true });

  // Re-clamp if the viewport crosses the desktop breakpoint while open
  // (e.g. left on screen 2 on a phone, then the window is widened).
  window.addEventListener('resize', () => { if (fsOpen) goScreen(fsScreen); });
}

// The second screen exists on phones only; desktop shows the cover view alone.
function maxScreen() {
  return window.matchMedia('(max-width: 720px)').matches ? 1 : 0;
}

function goScreen(i) {
  fsScreen = Math.max(0, Math.min(maxScreen(), i));
  fsEl.querySelector('#pf-strack').style.transform = `translateX(-${fsScreen * 50}%)`;
  fsEl.querySelector('#pf-prev-screen').hidden = fsScreen === 0;
  fsEl.querySelector('#pf-next-screen').hidden = fsScreen === 1;
  fsEl.querySelectorAll('.pf-dot').forEach((d, idx) => d.classList.toggle('active', idx === fsScreen));
}

function openFullscreen() {
  if (cursor < 0) return;
  fsEl.hidden = false;
  fsOpen = true;
  document.body.classList.add('pf-open');
  goScreen(0);
  updateFullscreen();
  syncFullscreenTime(
    audio.duration ? Math.round((audio.currentTime / audio.duration) * 1000) : 0,
    audio.currentTime || 0,
    audio.duration || 0,
  );
  setPlayIcon(audio.paused ? '▶' : '⏸');
  syncVolumeUI();
}

function closeFullscreen() {
  if (!fsOpen) return;
  fsOpen = false;
  if (fsEl) fsEl.hidden = true;
  document.body.classList.remove('pf-open');
  if (pfRxControl) { pfRxControl.unsub(); pfRxControl = null; pfRxSongId = null; }
}

// Repaint the overlay for the current track. No-op while closed.
async function updateFullscreen() {
  if (!fsOpen || !fsEl) return;
  const t = queue[cursor];
  if (!t) { closeFullscreen(); return; }

  fsEl.querySelector('#pf-title').textContent = t.title || 'Sans titre';
  fsEl.querySelector('#pf-artist').textContent = t.artist || '';

  // Cover (guarded against a track change mid-resolve).
  const cover = fsEl.querySelector('#pf-cover');
  cover.style.backgroundImage = '';
  cover.textContent = '';
  if (!t.coverPath) {
    cover.classList.add('placeholder');
    cover.textContent = (t.compilationTitle || t.title || '?')[0]?.toUpperCase() || '?';
  } else {
    cover.classList.remove('placeholder');
    const url = await coverUrl(t.coverPath);
    if (url && queue[cursor]?.coverPath === t.coverPath) cover.style.backgroundImage = `url(${url})`;
  }

  // Reaction control (own instance, full size), rebuilt only when song changes.
  const host = fsEl.querySelector('#pf-react');
  if (!(pfRxControl && pfRxSongId === t.songId)) {
    if (pfRxControl) pfRxControl.unsub();
    host.innerHTML = '';
    pfRxControl = createReactionControl(t.songId, { compact: false });
    pfRxSongId = t.songId;
    host.appendChild(pfRxControl.el);
    ensureCommunityReactionsLoaded().then(() => { if (pfRxSongId === t.songId) pfRxControl?.refresh(); });
  } else {
    pfRxControl.refresh();
  }

  // Screen 2: Discogs facts/link, bio, doublons — looked up from the catalog by
  // songId (the queue track may lack enrichment when built outside compilation view).
  const meta = fsEl.querySelector('#pf-meta');
  pfMetaSongId = t.songId;
  meta.innerHTML = '<div class="pf-meta-empty">…</div>';
  await ensureSongsLoaded();
  if (pfMetaSongId !== t.songId || !fsOpen) return;
  const song = getSong(t.songId);
  const facts = song ? enrichFactsHTML({
    year: song.year,
    label: song.label,
    artistTown: song.artistTown,
    artistCountry: song.artistCountry,
    artistBio: song.artistBio,
    discogsUrl: song.discogs?.releaseUrl || null,
  }, { bio: 'block' }) : '';
  const chips = song ? doublonChipsHTML(song.doublons, t.compilationId) : '';
  meta.innerHTML = (facts || chips)
    ? `${facts}${chips}`
    : '<div class="pf-meta-empty">Aucune information supplémentaire pour ce morceau.</div>';
  paintDoublonCovers(meta);
}

export function playQueue(tracks, opts = {}) {
  const { startIndex = 0, shuffle = false, sourceLabel: label = '' } = opts;
  if (!tracks?.length) return;
  queue = shuffle ? shuffleArr(tracks) : tracks.slice();
  sourceLabel = label;
  cursor = -1;
  playAt(Math.min(Math.max(0, startIndex), queue.length - 1));
}

export async function playAt(idx) {
  if (idx < 0 || idx >= queue.length) { stop(); return; }
  switching = true; // suppress auto-resume while we swap the outgoing track out
  cursor = idx;
  const t = queue[cursor];
  // Stop the outgoing track now. Otherwise it keeps playing audibly while we
  // resolve the next track's URL — and if that resolve/fetch fails, the player
  // would appear to "switch" in the UI while still playing the old audio.
  audio.pause();
  bar.hidden = false;
  document.body.classList.add('has-player');
  bar.querySelector('#pb-title').textContent = t.title || 'Sans titre';
  bar.querySelector('#pb-artist').textContent = t.artist || '';
  bar.querySelector('#pb-source').textContent = sourceLabel || t.compilationTitle || '';
  applyCover(t);
  renderReactionControl();
  updateFullscreen();
  queue.forEach((q, i) => q.li?.classList.toggle('playing', i === cursor));

  let url;
  try {
    url = await resolveAudioUrl(t.storagePath);
  } catch (err) {
    // The binary is missing/unreadable — skip to the next track rather than
    // leaving the player stuck. If the WHOLE queue is unavailable, stop trying
    // but keep the bar on this track (don't tear the player down).
    console.warn('Morceau indisponible, passage au suivant :', t.title, err?.code || err);
    skippedInARow += 1;
    if (skippedInARow >= queue.length) { skippedInARow = 0; switching = false; return; }
    // Wrap with modulo so skipping never runs off the end into stop().
    return playAt((idx + 1) % queue.length);
  }
  skippedInARow = 0;

  audio.src = url;
  try {
    await audio.play();
  } catch (err) {
    // Expected, non-fatal: NotAllowedError (autoplay blocked, stay paused) and
    // AbortError (this play() was superseded by a quick pause()/next track).
    if (err?.name !== 'NotAllowedError' && err?.name !== 'AbortError') console.error('playback failed', err);
  } finally {
    switching = false;
  }
  updateMediaSession();
  persist();
  prefetchAhead();
}

export function stop() {
  switching = false;
  userPaused = false;
  audio.pause();
  audio.removeAttribute('src');
  closeFullscreen();
  if (bar) bar.hidden = true;
  document.body.classList.remove('has-player');
  queue.forEach((q) => q.li?.classList.remove('playing'));
  cursor = -1;
  sessionStorage.removeItem(SESSION_KEY);
}

export function getCurrentTrack() {
  return queue[cursor] || null;
}

// ---- sessionStorage persistence ----
let persistTimer = null;
function persistThrottled() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; persist(); }, 1500);
}
function persist() {
  if (cursor < 0 || !queue[cursor]) return;
  // eslint-disable-next-line no-unused-vars
  const strip = ({ li, ...rest }) => rest;
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({
    track: strip(queue[cursor]),
    queue: queue.map(strip),
    cursor,
    sourceLabel,
    position: audio.currentTime || 0,
    paused: audio.paused,
  }));
}
async function restoreSession() {
  let saved;
  try { saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch (_) { saved = null; }
  if (!saved?.track?.storagePath) return;
  queue = saved.queue?.length ? saved.queue : [saved.track];
  cursor = saved.cursor ?? 0;
  sourceLabel = saved.sourceLabel || '';
  bar.hidden = false;
  document.body.classList.add('has-player');
  bar.querySelector('#pb-title').textContent = saved.track.title || 'Sans titre';
  bar.querySelector('#pb-artist').textContent = saved.track.artist || '';
  bar.querySelector('#pb-source').textContent = sourceLabel || saved.track.compilationTitle || '';
  applyCover(saved.track);
  renderReactionControl();
  updateFullscreen();
  try {
    const url = await resolveAudioUrl(saved.track.storagePath);
    audio.src = url;
    audio.currentTime = saved.position || 0;
    // Restore paused regardless of how the session was left: browsers block
    // autoplay without a user gesture, so attempting play() here just logs an
    // autoplay-policy warning and stays paused anyway. Let the user resume.
    userPaused = true;
    bar.querySelector('#pb-play').textContent = '▶';
    updateMediaSession();
  } catch (err) {
    /* ignore — session is best-effort */
  }
}

// ---- MediaSession (OS-level media keys) ----
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const set = (action, handler) => {
    // Not every browser supports every action; unsupported ones throw.
    try { navigator.mediaSession.setActionHandler(action, handler); } catch (_) { /* unsupported */ }
  };
  // `play` doubles as the resume signal after a call: clearing userPaused lets
  // the auto-resume paths take over again.
  set('play', () => { userPaused = false; audio.play().catch(() => {}); });
  set('pause', () => { userPaused = true; audio.pause(); });
  set('previoustrack', () => playAt(cursor - 1));
  set('nexttrack', () => playAt(cursor + 1));
  set('stop', () => stop());
  set('seekto', (d) => { if (d.seekTime != null && isFinite(d.seekTime)) audio.currentTime = d.seekTime; });
}
function setPlaybackState(state) {
  if (!('mediaSession' in navigator)) return;
  try { navigator.mediaSession.playbackState = state; } catch (_) { /* ignore */ }
}
// Keep the OS lock-screen scrubber in sync (and the session marked "live" so
// it survives an interruption and can be resumed from the lock screen).
function updatePositionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  const d = audio.duration;
  if (!isFinite(d) || d <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: d,
      playbackRate: audio.playbackRate || 1,
      position: Math.min(audio.currentTime, d),
    });
  } catch (_) { /* ignore out-of-range during seeks */ }
}
async function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const t = queue[cursor];
  if (!t) return;
  const meta = {
    title: t.title || 'Sans titre',
    artist: t.artist || '',
    album: t.compilationTitle || '',
  };
  if (t.coverPath) {
    const url = await coverUrl(t.coverPath);
    if (url) meta.artwork = [{ src: url, sizes: '512x512', type: 'image/jpeg' }];
  }
  navigator.mediaSession.metadata = new window.MediaMetadata(meta);
}
