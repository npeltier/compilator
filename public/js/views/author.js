// Author profile view at /author/:slug.
//
// `:slug` is a slugified displayName (or an 8-char hash of the email when no
// displayName exists yet) — emails never appear in URLs. We reverse-lookup the
// real author email by walking the loaded compilations.

import { db } from '../firebase-init.js';
import {
  collection,
  getDocs,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js';
import { coverUrl } from '../image-url.js';
import {
  visibleCompilations,
  allSongs,
  displayNameFor,
  emailFromAuthorSlug,
  getCompilation,
  getUser,
  trackFromSongId,
} from '../catalog.js';
import {
  dislikedSongIds,
  likedSongIds,
  onChange as onReactionChange,
  toggleDislike,
  toggleLike,
} from '../reactions.js';
import { playQueue } from '../player.js';
import { queueAuthor } from '../shuffle.js';
import { avatarHTML, avatarUrl, paintAvatars } from '../avatar.js';
import { filterBarHTML, wireFilterBar } from '../filter-bar.js';

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// A toggleable filter chip (optionally with an author avatar), mirroring the
// home view's author chips.
function mkAuthorChip(label, active, onClick, avatarEmail = null) {
  const a = document.createElement('a');
  a.className = 'chip' + (active ? ' active' : '');
  a.href = '#';
  a.setAttribute('role', 'button');
  a.setAttribute('aria-pressed', String(active));
  a.innerHTML = avatarEmail
    ? `${avatarHTML(avatarEmail, { size: 'xs' })}<span>${escape(label)}</span>`
    : escape(label);
  a.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
  return a;
}

export async function mount(el, { params }) {
  const slug = (params.name || '').toLowerCase();
  const emailKey = emailFromAuthorSlug(slug);
  if (!emailKey) {
    el.innerHTML = `
      <div class="shell">
        <div class="notice">Auteur introuvable.</div>
      </div>
    `;
    return;
  }
  const userDoc = getUser(emailKey);
  const displayName = displayNameFor(emailKey);
  const comps = visibleCompilations()
    .filter((c) => c.author === emailKey)
    .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));

  el.innerHTML = `
    <div class="shell">
      <header class="profile-hero">
        <div class="avatar avatar-xl ${userDoc?.avatarPath ? '' : 'placeholder'}" id="profileAvatar">
          ${userDoc?.avatarPath ? '' : escape((displayName || '?')[0].toUpperCase())}
        </div>
        <div>
          <p class="eyebrow">Profil</p>
          <h1>${escape(displayName)}</h1>
          <div class="profile-stats" id="profileStats"></div>
        </div>
      </header>

      ${filterBarHTML(`<div class="chip-row" id="seasonChips"></div>`)}
      <div class="shuffle-row" id="authorShuffleRow"></div>

      <section class="section">
        <h3>Compilations <span id="compCount" class="eyebrow" style="float:right"></span></h3>
        <div id="empty" class="notice" hidden>Aucune compilation pour cet auteur.</div>
        <div id="years"></div>
      </section>

      <section class="section">
        <h3>Ses coups de cœur <span id="hisLikesCount" class="eyebrow" style="float:right"></span></h3>
        <p style="color:var(--ink-faint);font-size:12px;margin:-4px 0 16px;">
          Les morceaux qu'il a aimés, n'importe où dans le catalogue.
        </p>
        <ul id="hisLikesList" class="likes-list"></ul>
        <div id="hisLikesEmpty" class="notice" hidden>Pas encore de coups de cœur.</div>
      </section>

      <section class="section">
        <h3>Ses compilations aimées <span id="hisLikedCompsCount" class="eyebrow" style="float:right"></span></h3>
        <p style="color:var(--ink-faint);font-size:12px;margin:-4px 0 16px;">
          Les compilations qu'il a aimées, n'importe où dans le catalogue.
        </p>
        <div class="chip-row" id="hisLikedCompsAuthors"></div>
        <div id="hisLikedComps"></div>
        <div id="hisLikedCompsEmpty" class="notice" hidden>Pas encore de compilation aimée.</div>
      </section>

      <section class="section">
        <h3>Mes réactions sur ses morceaux <span id="rxCount" class="eyebrow" style="float:right"></span></h3>
        <p style="color:var(--ink-faint);font-size:12px;margin:-4px 0 16px;">
          Tes ❤️ et 😬 sur les morceaux issus de ses compilations.
        </p>
        <ul id="rxList" class="likes-list"></ul>
        <div id="rxEmpty" class="notice" hidden>Aucune réaction sur ses morceaux pour l'instant.</div>
      </section>
    </div>
  `;

  if (userDoc?.avatarPath) {
    const url = await avatarUrl(userDoc.avatarPath);
    if (url) el.querySelector('#profileAvatar').style.backgroundImage = `url(${url})`;
  }

  // The catalog already attaches each song to its parent compilation, so we
  // can filter in memory — no extra Firestore round trips.
  const compIdSet = new Set(comps.map((c) => c.id));
  const songIdSet = new Set(
    allSongs().filter((s) => compIdSet.has(s.compilationId)).map((s) => s.id),
  );

  const totalTracks = songIdSet.size;
  el.querySelector('#profileStats').textContent =
    `${comps.length} compilation${comps.length > 1 ? 's' : ''} · ${totalTracks} morceau${totalTracks > 1 ? 'x' : ''}`;

  el.querySelector('#compCount').textContent = comps.length
    ? `${comps.length} ${comps.length > 1 ? 'titres' : 'titre'}`
    : '';
  el.querySelector('#empty').hidden = comps.length > 0;

  // Distinct (season, year) buckets for this author, sorted by year desc then
  // by season (Été before Noël within a year).
  const seasonLabel = { ete: 'Été', noel: 'Noël' };
  const seasonOrder = { ete: 0, noel: 1 };
  const buckets = [];
  const seenKeys = new Set();
  comps.forEach((c) => {
    const key = `${c.season || 'other'}-${c.year || ''}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    buckets.push({ key, season: c.season, year: c.year });
  });
  buckets.sort((a, b) => {
    if (a.year !== b.year) return (b.year || 0) - (a.year || 0);
    return (seasonOrder[a.season] ?? 9) - (seasonOrder[b.season] ?? 9);
  });

  let filterKey = null;
  const compsForFilter = (k) => k
    ? comps.filter((c) => `${c.season || 'other'}-${c.year || ''}` === k)
    : comps;
  const tracksForFilter = (k) => {
    const ids = new Set(compsForFilter(k).map((c) => c.id));
    return allSongs()
      .filter((s) => ids.has(s.compilationId))
      .map((s) => trackFromSongId(s.id))
      .filter(Boolean);
  };

  function renderChips() {
    const chips = el.querySelector('#seasonChips');
    chips.innerHTML = '';
    const mkChip = (label, key) => {
      const a = document.createElement('a');
      a.className = 'chip' + (filterKey === key ? ' active' : '');
      a.href = '#';
      a.textContent = label;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        filterKey = key;
        renderChips();
        renderShuffle();
        renderCompilationsGrid(el.querySelector('#years'), compsForFilter(filterKey), false);
      });
      return a;
    };
    if (buckets.length === 0) return;
    chips.appendChild(mkChip('Tout', null));
    buckets.forEach((b) => {
      const label = `${seasonLabel[b.season] || ''} ${b.year || ''}`.trim();
      chips.appendChild(mkChip(label, b.key));
    });
  }

  function renderShuffle() {
    const shuffleRow = el.querySelector('#authorShuffleRow');
    shuffleRow.innerHTML = '';
    const tracks = tracksForFilter(filterKey);
    if (tracks.length === 0) return;
    const btn = document.createElement('button');
    btn.className = 'shuffle-btn';
    const scope = filterKey
      ? buckets.find((b) => b.key === filterKey)
      : null;
    const scopeLabel = scope ? `${seasonLabel[scope.season] || ''} ${scope.year || ''}`.trim() : '';
    btn.innerHTML = scope
      ? `🔀 ${escape(scopeLabel)} en aléatoire`
      : `🔀 Tout en aléatoire`;
    btn.addEventListener('click', async () => {
      // Reuse queueAuthor when no filter; otherwise build from our filtered list
      // (already shuffled-randomly via shuffleArr below).
      const shuffled = scope
        ? tracks.slice().sort(() => Math.random() - 0.5)
        : await queueAuthor(emailKey);
      playQueue(shuffled, {
        sourceLabel: scope
          ? `${scopeLabel} chez ${displayName} en aléatoire`
          : `Chez ${displayName} en aléatoire`,
      });
    });
    shuffleRow.appendChild(btn);
  }

  renderChips();
  renderShuffle();
  // No season/year buckets → nothing to filter, so drop the bar entirely.
  if (buckets.length === 0) el.querySelector('#filterBar')?.remove();
  else wireFilterBar(el);
  renderCompilationsGrid(el.querySelector('#years'), comps, true);

  function renderReactions() {
    const rxList = el.querySelector('#rxList');
    const rxEmpty = el.querySelector('#rxEmpty');
    const rxCount = el.querySelector('#rxCount');
    const likes = likedSongIds().filter((id) => songIdSet.has(id));
    const dislikes = dislikedSongIds().filter((id) => songIdSet.has(id));
    const all = [
      ...likes.map((songId) => ({ songId, kind: 'like' })),
      ...dislikes.map((songId) => ({ songId, kind: 'dislike' })),
    ];
    rxList.innerHTML = '';
    rxCount.textContent = all.length ? `${all.length}` : '';
    rxEmpty.hidden = all.length > 0;

    const playableLikes = likes.map((id) => trackFromSongId(id)).filter(Boolean);

    all.forEach((entry) => {
      const t = trackFromSongId(entry.songId);
      if (!t) return;
      const isLike = entry.kind === 'like';
      const li = document.createElement('li');
      li.innerHTML = `
        <button class="lk-play" title="Jouer ce morceau">▶</button>
        <div class="lk-meta">
          <div class="title">${escape(t.title)}</div>
          <div class="artist">${escape(t.artist)} ${t.compilationId ? `· <a href="/c/${t.compilationId}">${escape(t.compilationTitle)}</a>` : ''}</div>
        </div>
        <button class="lk-rx" title="${isLike ? 'Retirer le ❤️' : 'Retirer le 😬'}" aria-label="Retirer">${isLike ? '❤️' : '😬'}</button>
      `;
      li.querySelector('.lk-play').addEventListener('click', () => {
        if (isLike && playableLikes.length > 0) {
          const idx = playableLikes.findIndex((p) => p.songId === entry.songId);
          playQueue(playableLikes, { startIndex: Math.max(0, idx), sourceLabel: `❤️ chez ${displayName}` });
        } else {
          playQueue([t], { startIndex: 0, sourceLabel: `Chez ${displayName}` });
        }
      });
      li.querySelector('.lk-rx').addEventListener('click', async () => {
        if (isLike) await toggleLike(entry.songId);
        else await toggleDislike(entry.songId);
      });
      rxList.appendChild(li);
    });
  }
  renderReactions();
  const unsub = onReactionChange(renderReactions);

  // Fetch the author's own ❤️ likes (rules let any allowlisted user read
  // others' reactions; we only display likes, not dislikes).
  renderHisLikes().catch((err) => console.warn('hisLikes fetch failed', err));

  // Fetch the author's liked compilations (same read permission as reactions),
  // then render with a per-author filter over the result.
  const gridWrap = el.querySelector('#hisLikedComps');
  const authorsWrap = el.querySelector('#hisLikedCompsAuthors');
  const hisLikedCompsEmptyEl = el.querySelector('#hisLikedCompsEmpty');
  const hisLikedCompsCountEl = el.querySelector('#hisLikedCompsCount');
  let hisLikedComps = [];
  const selectedHisLikedAuthors = new Set();

  fetchHisLikedComps().catch((err) => console.warn('hisLikedComps fetch failed', err));

  async function fetchHisLikedComps() {
    const snap = await getDocs(collection(db, 'users', emailKey, 'likedCompilations'));
    // Resolve to compilations still in the catalog, newest first.
    hisLikedComps = snap.docs.map((d) => getCompilation(d.id)).filter(Boolean)
      .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    renderHisLikedComps();
  }

  function renderHisLikedComps() {
    hisLikedCompsCountEl.textContent = hisLikedComps.length
      ? `${hisLikedComps.length} compilation${hisLikedComps.length > 1 ? 's' : ''}` : '';
    hisLikedCompsEmptyEl.hidden = hisLikedComps.length > 0;

    const authors = [...new Set(hisLikedComps.map((c) => c.author).filter(Boolean))]
      .sort((a, b) => displayNameFor(a).localeCompare(displayNameFor(b), 'fr'));
    for (const a of [...selectedHisLikedAuthors]) if (!authors.includes(a)) selectedHisLikedAuthors.delete(a);

    authorsWrap.innerHTML = '';
    if (authors.length > 1) {
      authorsWrap.appendChild(mkAuthorChip('Tout', selectedHisLikedAuthors.size === 0, () => {
        selectedHisLikedAuthors.clear();
        renderHisLikedComps();
      }));
      authors.forEach((email) => authorsWrap.appendChild(mkAuthorChip(
        displayNameFor(email),
        selectedHisLikedAuthors.has(email),
        () => {
          selectedHisLikedAuthors.has(email) ? selectedHisLikedAuthors.delete(email) : selectedHisLikedAuthors.add(email);
          renderHisLikedComps();
        },
        email,
      )));
    }

    const comps = selectedHisLikedAuthors.size
      ? hisLikedComps.filter((c) => selectedHisLikedAuthors.has(c.author))
      : hisLikedComps;

    const grid = document.createElement('div');
    grid.className = 'cover-grid';
    comps.forEach((c) => {
      const card = document.createElement('div');
      card.className = 'cover-card';
      const firstChar = (c.title || '?')[0].toUpperCase();
      card.innerHTML = `
        <a class="cover-card-art" href="/c/${c.id}">
          <div class="art ${c.coverPath ? '' : 'placeholder'}">${c.coverPath ? '' : firstChar}</div>
          <div class="title">${escape(c.title)}</div>
        </a>
        <a class="cover-card-author" href="#" role="button" title="Filtrer par ${escape(displayNameFor(c.author))}">
          ${avatarHTML(c.author, { size: 'xs' })}
          <span class="author">${escape(displayNameFor(c.author))}</span>
        </a>
      `;
      card.querySelector('.cover-card-author').addEventListener('click', (e) => {
        e.preventDefault();
        selectedHisLikedAuthors.clear();
        selectedHisLikedAuthors.add(c.author);
        renderHisLikedComps();
      });
      grid.appendChild(card);
      if (c.coverPath) {
        coverUrl(c.coverPath).then((url) => { if (url) card.querySelector('.art').style.backgroundImage = `url(${url})`; });
      }
    });
    gridWrap.innerHTML = '';
    gridWrap.appendChild(grid);
    paintAvatars(gridWrap);
    paintAvatars(authorsWrap);
  }

  async function renderHisLikes() {
    const listEl = el.querySelector('#hisLikesList');
    const emptyEl = el.querySelector('#hisLikesEmpty');
    const countEl = el.querySelector('#hisLikesCount');
    const snap = await getDocs(collection(db, 'users', emailKey, 'reactions'));
    const likedIds = [];
    snap.forEach((d) => { if (d.data().value === 'like') likedIds.push(d.id); });

    // Resolve to playable tracks, skipping any orphans (song no longer in catalog).
    const tracks = likedIds.map((id) => trackFromSongId(id)).filter(Boolean);
    countEl.textContent = tracks.length ? `${tracks.length} morceau${tracks.length > 1 ? 'x' : ''}` : '';
    emptyEl.hidden = tracks.length > 0;
    listEl.innerHTML = '';
    tracks.forEach((t, i) => {
      const li = document.createElement('li');
      li.innerHTML = `
        <button class="lk-play" title="Jouer à partir d'ici">▶</button>
        <div class="lk-meta">
          <div class="title">${escape(t.title)}</div>
          <div class="artist">${escape(t.artist)} ${t.compilationId ? `· <a href="/c/${t.compilationId}">${escape(t.compilationTitle)}</a>` : ''}</div>
        </div>
        <span class="dur">❤️</span>
      `;
      li.querySelector('.lk-play').addEventListener('click', () => {
        playQueue(tracks, { startIndex: i, sourceLabel: `Coups de cœur de ${displayName}` });
      });
      listEl.appendChild(li);
    });
  }

  return () => unsub();
}

function renderCompilationsGrid(yearsEl, comps, flat = false) {
  yearsEl.innerHTML = '';
  if (comps.length === 0) return;

  const seasonLabel = { ete: 'Été', noel: 'Noël' };
  const seasonOrder = { ete: 0, noel: 1 };

  const groupMap = new Map();
  for (const c of comps) {
    const y = c.year || new Date(c.createdAt?.toMillis?.() || Date.now()).getFullYear();
    const key = `${y}-${c.season || 'other'}`;
    if (!groupMap.has(key)) groupMap.set(key, { year: y, season: c.season || 'other', list: [] });
    groupMap.get(key).list.push(c);
  }
  const groups = [...groupMap.values()].sort((a, b) => {
    if (a.year !== b.year) return (b.year || 0) - (a.year || 0);
    return (seasonOrder[a.season] ?? 9) - (seasonOrder[b.season] ?? 9);
  });

  if (flat) {
    const grid = document.createElement('div');
    grid.className = 'cover-grid';

    for (const group of groups) {
      const lbl = document.createElement('div');
      lbl.className = `season-inline-label${group.season === 'noel' ? ' winter' : group.season === 'ete' ? ' summer' : ''}`;
      lbl.textContent = `${seasonLabel[group.season] || ''} ${group.year}`.trim();
      grid.appendChild(lbl);

      for (const c of group.list) {
        const card = document.createElement('a');
        card.className = 'cover-card';
        card.href = `/c/${c.id}`;
        const firstChar = (c.title || '?')[0].toUpperCase();
        card.innerHTML = `
          <div class="art ${c.coverPath ? '' : 'placeholder'}">${c.coverPath ? '' : firstChar}</div>
          <div class="title">${escape(c.title)}</div>
        `;
        grid.appendChild(card);
        if (c.coverPath) {
          coverUrl(c.coverPath).then((url) => { if (url) card.querySelector('.art').style.backgroundImage = `url(${url})`; });
        }
      }
    }

    yearsEl.appendChild(grid);
    return;
  }

  for (const group of groups) {
    const block = document.createElement('section');
    block.className = `season-block${group.season === 'noel' ? ' winter' : group.season === 'ete' ? ' summer' : ''}`;
    const labelTxt = `${seasonLabel[group.season] || ''} ${group.year}`.trim();
    block.innerHTML = `
      <header>
        <h2>${labelTxt}</h2>
        <span class="count">${group.list.length} compilation${group.list.length > 1 ? 's' : ''}</span>
      </header>
      <div class="cover-grid"></div>
    `;
    const grid = block.querySelector('.cover-grid');
    for (const c of group.list) {
      const card = document.createElement('a');
      card.className = 'cover-card';
      card.href = `/c/${c.id}`;
      const firstChar = (c.title || '?')[0].toUpperCase();
      card.innerHTML = `
        <div class="art ${c.coverPath ? '' : 'placeholder'}">${c.coverPath ? '' : firstChar}</div>
        <div class="title">${escape(c.title)}</div>
      `;
      grid.appendChild(card);
      if (c.coverPath) {
        coverUrl(c.coverPath).then((url) => { if (url) card.querySelector('.art').style.backgroundImage = `url(${url})`; });
      }
    }
    yearsEl.appendChild(block);
  }
}
