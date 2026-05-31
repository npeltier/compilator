// Minimal in-page audio player. Renders a fixed bottom bar; supports a queue of
// tracks with autoadvance, scrubbing, prev/next, and Spacebar play-pause.

import { storage } from './firebase-init.js';
import { ref as storageRef, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-storage.js';

let queue = [];           // [{ storagePath, title, artist, duration, li }]
let cursor = -1;
const audio = new Audio();
let bar;

function ensureBar() {
  if (bar) return bar;
  bar = document.createElement('div');
  bar.className = 'player-bar';
  bar.hidden = true;
  bar.innerHTML = `
    <div class="now">
      <div class="t" id="pb-title">—</div>
      <div class="a" id="pb-artist"></div>
    </div>
    <div class="controls">
      <button class="icon" id="pb-prev" title="Précédent">⏮</button>
      <button class="icon" id="pb-play" title="Lecture / pause">▶</button>
      <button class="icon" id="pb-next" title="Suivant">⏭</button>
      <span class="time" id="pb-cur">0:00</span>
      <div class="scrub"><input type="range" id="pb-scrub" min="0" max="1000" value="0" step="1"></div>
      <span class="time" id="pb-tot">0:00</span>
    </div>
    <button class="btn-ghost" id="pb-stop">Arrêter</button>
  `;
  document.body.appendChild(bar);
  bar.querySelector('#pb-play').addEventListener('click', () => audio.paused ? audio.play() : audio.pause());
  bar.querySelector('#pb-prev').addEventListener('click', () => playAt(cursor - 1));
  bar.querySelector('#pb-next').addEventListener('click', () => playAt(cursor + 1));
  bar.querySelector('#pb-stop').addEventListener('click', stop);
  const scrub = bar.querySelector('#pb-scrub');
  scrub.addEventListener('input', () => {
    if (audio.duration) audio.currentTime = (scrub.value / 1000) * audio.duration;
  });
  audio.addEventListener('timeupdate', () => {
    const d = audio.duration || 0;
    scrub.value = d ? Math.round((audio.currentTime / d) * 1000) : 0;
    bar.querySelector('#pb-cur').textContent = fmt(audio.currentTime);
    bar.querySelector('#pb-tot').textContent = fmt(d);
  });
  audio.addEventListener('play', () => bar.querySelector('#pb-play').textContent = '⏸');
  audio.addEventListener('pause', () => bar.querySelector('#pb-play').textContent = '▶');
  audio.addEventListener('ended', () => playAt(cursor + 1));
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.code === 'Space') { e.preventDefault(); audio.paused ? audio.play() : audio.pause(); }
  });
  return bar;
}

function fmt(s) {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60); const r = Math.floor(s % 60);
  return `${m}:${r.toString().padStart(2, '0')}`;
}

export function setQueue(tracks) {
  queue = tracks;
  cursor = -1;
  ensureBar();
}

export async function playAt(idx) {
  if (idx < 0 || idx >= queue.length) { stop(); return; }
  cursor = idx;
  const t = queue[cursor];
  ensureBar();
  bar.hidden = false;
  bar.querySelector('#pb-title').textContent = t.title || 'Sans titre';
  bar.querySelector('#pb-artist').textContent = t.artist || '';
  queue.forEach((q, i) => q.li?.classList.toggle('playing', i === cursor));
  try {
    const url = await getDownloadURL(storageRef(storage, t.storagePath));
    audio.src = url;
    await audio.play();
  } catch (err) {
    console.error('playback failed', err);
  }
}

export function stop() {
  audio.pause();
  audio.removeAttribute('src');
  if (bar) bar.hidden = true;
  queue.forEach((q) => q.li?.classList.remove('playing'));
  cursor = -1;
}
