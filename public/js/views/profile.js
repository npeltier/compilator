// Profile view: edit displayName + browse own ❤️ likes.

import { auth, db } from '../firebase-init.js';
import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js';
import {
  likedSongIds,
  onChange as onReactionChange,
  toggleLike,
} from '../reactions.js';
import { getPlacement, trackFromSongId } from '../catalog.js';
import { playQueue } from '../player.js';

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export async function mount(el) {
  const user = auth.currentUser;
  el.innerHTML = `
    <div class="shell-narrow">
      <p class="eyebrow">Profil</p>
      <h1>Qui tu es.</h1>

      <div id="error" class="error" hidden></div>
      <div id="ok" class="notice" hidden>Enregistré.</div>

      <form id="form">
        <label for="email">Adresse e-mail</label>
        <input id="email" disabled>

        <label for="displayName" style="margin-top:24px;">Nom d'affichage</label>
        <input id="displayName" placeholder="Nicolas P." required>
        <p style="color:var(--ink-faint);font-size:12px;margin-top:6px;">
          Affiché comme auteur des compilations que tu envoies. Utilise la même forme que sur l'ancien site
          (ex. <i>Nicolas P.</i>, <i>François D.</i>, <i>Céline</i>) pour que les anciennes et nouvelles compilations se regroupent.
        </p>

        <button type="submit" class="btn-accent" style="margin-top:24px;">Enregistrer</button>
      </form>

      <section class="section" style="margin-top:64px;">
        <h3>Mes coups de cœur <span id="likesCount" class="eyebrow" style="float:right"></span></h3>
        <ul id="likes" class="likes-list"></ul>
        <div id="likesEmpty" class="notice" hidden>Aucun ❤️ pour l'instant. Mets ton premier ❤️ depuis n'importe quelle compilation.</div>
      </section>
    </div>
  `;

  const userDocRef = doc(db, 'users', user.uid);
  const userDocSnap = await getDoc(userDocRef);
  const data = userDocSnap.exists() ? userDocSnap.data() : {};
  el.querySelector('#email').value = user.email;
  el.querySelector('#displayName').value = data.displayName || user.email.split('@')[0];

  el.querySelector('#form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = el.querySelector('#error');
    const okEl = el.querySelector('#ok');
    errEl.hidden = true; okEl.hidden = true;
    const displayName = el.querySelector('#displayName').value.trim();
    if (!displayName) return;
    try {
      await setDoc(userDocRef, { displayName, updatedAt: serverTimestamp() }, { merge: true });
      okEl.hidden = false;
    } catch (err) {
      errEl.textContent = err.message; errEl.hidden = false;
    }
  });

  const likesEl = el.querySelector('#likes');
  const emptyEl = el.querySelector('#likesEmpty');
  const countEl = el.querySelector('#likesCount');

  function renderLikes() {
    likesEl.innerHTML = '';
    const ids = likedSongIds();
    countEl.textContent = ids.length ? `${ids.length} morceau${ids.length > 1 ? 'x' : ''}` : '';
    emptyEl.hidden = ids.length > 0;
    ids.forEach((songId, i) => {
      const t = trackFromSongId(songId);
      if (!t) return;
      const placement = getPlacement(songId);
      const li = document.createElement('li');
      li.innerHTML = `
        <button class="lk-play" title="Jouer à partir d'ici">▶</button>
        <div class="lk-meta">
          <div class="title">${escape(t.title)}</div>
          <div class="artist">${escape(t.artist)} ${placement ? `· <a href="/c/${placement.compilationId}">${escape(placement.compilationTitle)}</a>` : ''}</div>
        </div>
        <button class="lk-unlike" title="Retirer le ❤️" aria-label="Retirer">❤️</button>
      `;
      li.querySelector('.lk-play').addEventListener('click', () => {
        const queue = ids.map((sid) => trackFromSongId(sid)).filter(Boolean);
        playQueue(queue, { startIndex: i, sourceLabel: 'Mes coups de cœur' });
      });
      li.querySelector('.lk-unlike').addEventListener('click', async () => {
        await toggleLike(songId);
      });
      likesEl.appendChild(li);
    });
  }
  renderLikes();
  const unsub = onReactionChange(renderLikes);
  return () => unsub();
}
