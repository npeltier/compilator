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
import {
  getReaction,
  onChange as onReactionChange,
  toggleLike,
  toggleDislike,
} from './reactions.js';
import { navigate } from './router.js';

const SESSION_KEY = 'compilator.player.v1';

const audio = new Audio();
audio.preload = 'metadata';

let queue = [];
let cursor = -1;
let sourceLabel = '';
let userPaused = false;
let bar;
const coverUrlCache = new Map(); // coverPath → resolved download URL (download URLs are stable)
const audioUrlCache = new Map(); // storagePath → resolved download URL (same)

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
      <button class="icon react" id="pb-like" title="J'aime" aria-label="J'aime">🤍</button>
      <button class="icon react" id="pb-dislike" title="Je n'aime pas" aria-label="Je n'aime pas">😬</button>
      <button class="btn-ghost" id="pb-stop">Arrêter</button>
    </div>
  `;
  document.body.appendChild(bar);

  bar.querySelector('#pb-play').addEventListener('click', () => {
    if (audio.paused) { userPaused = false; audio.play(); }
    else { userPaused = true; audio.pause(); }
  });
  bar.querySelector('#pb-prev').addEventListener('click', () => playAt(cursor - 1));
  bar.querySelector('#pb-next').addEventListener('click', () => playAt(cursor + 1));
  bar.querySelector('#pb-stop').addEventListener('click', stop);
  bar.querySelector('#pb-cover').addEventListener('click', () => {
    const t = queue[cursor];
    if (t?.compilationId) navigate(`/c/${t.compilationId}`);
  });
  bar.querySelector('#pb-like').addEventListener('click', async () => {
    const t = queue[cursor];
    if (t?.songId) await toggleLike(t.songId);
  });
  bar.querySelector('#pb-dislike').addEventListener('click', async () => {
    const t = queue[cursor];
    if (t?.songId) await toggleDislike(t.songId);
  });

  const scrub = bar.querySelector('#pb-scrub');
  scrub.addEventListener('input', () => {
    if (audio.duration) audio.currentTime = (scrub.value / 1000) * audio.duration;
  });
  audio.addEventListener('timeupdate', () => {
    const d = audio.duration || 0;
    scrub.value = d ? Math.round((audio.currentTime / d) * 1000) : 0;
    bar.querySelector('#pb-cur').textContent = fmt(audio.currentTime);
    bar.querySelector('#pb-tot').textContent = fmt(d);
    persistThrottled();
  });
  audio.addEventListener('play', () => { userPaused = false; bar.querySelector('#pb-play').textContent = '⏸'; persist(); });
  audio.addEventListener('pause', () => { bar.querySelector('#pb-play').textContent = '▶'; persist(); });
  // Resume after phone-call or system interruption (not user-initiated pause).
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && audio.paused && !userPaused && cursor >= 0) {
      audio.play().catch(() => {});
    }
  });
  audio.addEventListener('ended', () => playAt(cursor + 1));

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
    if (e.code === 'Space') { e.preventDefault(); audio.paused ? audio.play() : audio.pause(); }
  });

  onReactionChange((songId) => {
    if (queue[cursor]?.songId === songId) renderReactionButtons();
  });

  setupMediaSession();
  restoreSession();
}

function renderReactionButtons() {
  const t = queue[cursor];
  const likeBtn = bar.querySelector('#pb-like');
  const disBtn = bar.querySelector('#pb-dislike');
  const r = t?.songId ? getReaction(t.songId) : null;
  likeBtn.textContent = r === 'like' ? '❤️' : '🤍';
  likeBtn.classList.toggle('active', r === 'like');
  disBtn.classList.toggle('active', r === 'dislike');
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
  if (coverUrlCache.has(track.coverPath)) {
    cover.style.backgroundImage = `url(${coverUrlCache.get(track.coverPath)})`;
    return;
  }
  try {
    const url = await getDownloadURL(storageRef(storage, track.coverPath));
    coverUrlCache.set(track.coverPath, url);
    // Only apply if we're still on the same track.
    if (queue[cursor]?.coverPath === track.coverPath) {
      cover.style.backgroundImage = `url(${url})`;
    }
  } catch (err) {
    /* keep placeholder */
  }
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
  cursor = idx;
  const t = queue[cursor];
  bar.hidden = false;
  document.body.classList.add('has-player');
  bar.querySelector('#pb-title').textContent = t.title || 'Sans titre';
  bar.querySelector('#pb-artist').textContent = t.artist || '';
  bar.querySelector('#pb-source').textContent = sourceLabel || t.compilationTitle || '';
  applyCover(t);
  renderReactionButtons();
  queue.forEach((q, i) => q.li?.classList.toggle('playing', i === cursor));
  try {
    const url = await resolveAudioUrl(t.storagePath);
    audio.src = url;
    await audio.play();
    updateMediaSession();
    persist();
    prefetchAhead();
  } catch (err) {
    console.error('playback failed', err);
  }
}

export function stop() {
  audio.pause();
  audio.removeAttribute('src');
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
  renderReactionButtons();
  try {
    const url = await resolveAudioUrl(saved.track.storagePath);
    audio.src = url;
    audio.currentTime = saved.position || 0;
    userPaused = !!saved.paused;
    if (!saved.paused) await audio.play();
    updateMediaSession();
  } catch (err) {
    /* ignore — session is best-effort */
  }
}

// ---- MediaSession (OS-level media keys) ----
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.setActionHandler('play', () => audio.play());
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('previoustrack', () => playAt(cursor - 1));
  navigator.mediaSession.setActionHandler('nexttrack', () => playAt(cursor + 1));
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
    try {
      const url = coverUrlCache.get(t.coverPath)
        || await getDownloadURL(storageRef(storage, t.coverPath));
      coverUrlCache.set(t.coverPath, url);
      meta.artwork = [{ src: url, sizes: '512x512', type: 'image/jpeg' }];
    } catch (_) { /* ignore */ }
  }
  navigator.mediaSession.metadata = new window.MediaMetadata(meta);
}
