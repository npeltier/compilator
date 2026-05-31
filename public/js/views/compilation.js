// Compilation view: cover hero, ordered track list with ❤️/💩 buttons per row.

import { db, storage } from '../firebase-init.js';
import {
  collection,
  getDocs,
  orderBy,
  query,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js';
import {
  ref as storageRef,
  getDownloadURL,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-storage.js';
import { playQueue } from '../player.js';
import {
  getReaction,
  toggleLike,
  toggleDislike,
  onChange as onReactionChange,
} from '../reactions.js';
import { getCompilation, getSong } from '../catalog.js';

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function fmt(s) {
  return isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '';
}

export async function mount(el, { params }) {
  const id = params.id;
  el.innerHTML = `<div class="shell" id="main"></div>`;
  const main = el.querySelector('#main');

  if (!id) {
    main.innerHTML = '<div class="notice">Aucun identifiant de compilation.</div>';
    return;
  }
  const comp = getCompilation(id);
  if (!comp) {
    main.innerHTML = '<div class="notice">Compilation introuvable.</div>';
    return;
  }

  const tracksSnap = await getDocs(query(collection(db, 'compilations', id, 'tracks'), orderBy('order', 'asc')));
  const tracks = tracksSnap.docs.map((d) => {
    const t = d.data();
    const s = getSong(t.songId) || {};
    return {
      songId: t.songId,
      order: t.order,
      title: t.title || s.title || 'Sans titre',
      artist: t.artist || s.artist || '',
      duration: t.duration || s.duration || 0,
      storagePath: s.storagePath,
      compilationId: comp.id,
      compilationTitle: comp.title,
      coverPath: comp.coverPath || null,
    };
  });

  const totalDur = tracks.reduce((a, t) => a + (t.duration || 0), 0);

  main.innerHTML = `
    <div class="detail-hero">
      <div class="art ${comp.coverPath ? '' : 'placeholder'}" id="hero-art"></div>
      <div class="meta">
        <p class="eyebrow">${comp.season === 'noel' ? '❄ Noël' : '☀ Été'} ${comp.year || ''}</p>
        <h1>${escape(comp.title)}</h1>
        <div class="by">par <a href="/author/${encodeURIComponent(comp.authorName)}">${escape(comp.authorName)}</a></div>
        <div class="stats">${tracks.length} morceau${tracks.length > 1 ? 'x' : ''} · ${fmt(totalDur)}</div>
        <div style="margin-top:24px;">
          <button class="btn-accent" id="playAll">▶ Tout écouter</button>
        </div>
      </div>
    </div>
    <ol class="tracklist" id="tracks"></ol>
  `;

  if (comp.coverPath) {
    try {
      const url = await getDownloadURL(storageRef(storage, comp.coverPath));
      main.querySelector('#hero-art').style.backgroundImage = `url(${url})`;
    } catch (_) { /* ignore */ }
  } else {
    main.querySelector('#hero-art').textContent = (comp.title || '?')[0].toUpperCase();
  }

  const tracksEl = main.querySelector('#tracks');
  tracks.forEach((t, i) => {
    const li = document.createElement('li');
    li.dataset.songId = t.songId;
    li.innerHTML = `
      <span class="num">${i + 1}</span>
      <div class="tk-meta">
        <div class="title">${escape(t.title)}</div>
        <div class="artist">${escape(t.artist)}</div>
      </div>
      <div class="tk-react">
        <button class="rx-like" title="J'aime" aria-label="J'aime">🤍</button>
        <button class="rx-dis" title="Je n'aime pas" aria-label="Je n'aime pas">💩</button>
      </div>
      <span class="dur">${fmt(t.duration)}</span>
    `;
    // Play on click, but not when clicking the react buttons.
    li.addEventListener('click', (e) => {
      if (e.target.closest('.tk-react')) return;
      playQueue(tracks, { startIndex: i, sourceLabel: comp.title });
    });
    li.querySelector('.rx-like').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleLike(t.songId);
    });
    li.querySelector('.rx-dis').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDislike(t.songId);
    });
    tracksEl.appendChild(li);
    t.li = li;
  });

  function renderRowReactions(songId) {
    const li = tracksEl.querySelector(`li[data-song-id="${songId}"]`);
    if (!li) return;
    const r = getReaction(songId);
    const like = li.querySelector('.rx-like');
    const dis = li.querySelector('.rx-dis');
    like.textContent = r === 'like' ? '❤️' : '🤍';
    like.classList.toggle('active', r === 'like');
    dis.classList.toggle('active', r === 'dislike');
  }
  // Initial paint
  tracks.forEach((t) => renderRowReactions(t.songId));
  const unsub = onReactionChange((songId) => renderRowReactions(songId));

  main.querySelector('#playAll').addEventListener('click', () => {
    playQueue(tracks, { startIndex: 0, sourceLabel: comp.title });
  });

  return () => unsub();
}
