// Home view: next-slot banner, author chips, cover grid grouped by year+season,
// plus the cross-compilation shuffle buttons (Tout / Sauf � / Mes ❤️).

import { auth, db, storage } from '../firebase-init.js';
import { nextCompilationSlot, slotLabel, deadlineLabel } from '../slot.js';
import { allCompilations, authorSlug, displayNameFor } from '../catalog.js';
import { likeCount } from '../reactions.js';
import {
  queueAllSongs,
  queueAllExceptDisliked,
  queueLikedSongs,
  queueSeasonYear,
} from '../shuffle.js';
import { playQueue } from '../player.js';
import {
  ref as storageRef,
  getDownloadURL,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-storage.js';
import { avatarHTML, paintAvatars } from '../avatar.js';

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const coverObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    coverObserver.unobserve(entry.target);
    const path = entry.target.dataset.coverPath;
    if (path) {
      getDownloadURL(storageRef(storage, path))
        .then((url) => { entry.target.style.backgroundImage = `url(${url})`; })
        .catch(() => {});
    }
  }
}, { rootMargin: '200px' });

export async function mount(el, { query }) {
  const filterAuthor = query.author || null;
  el.innerHTML = `
    <div class="shell">
      <div id="nextBanner"></div>
      <div class="shuffle-row" id="shuffleRow"></div>
      <div class="chip-row" id="authorChips"></div>
      <div class="chip-row" id="seasonChips"></div>
      <div id="empty" class="notice" hidden>Aucune compilation pour l'instant. <a href="/upload">Crée la première</a>.</div>
      <div id="years"></div>
    </div>
  `;

  const user = auth.currentUser;
  const emailKey = user.email.toLowerCase();
  const comps = allCompilations()
    .slice()
    .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));

  // ---- Next-slot banner ----
  const slot = nextCompilationSlot();
  const mine = comps.find((c) => c.author === emailKey && c.season === slot.season && c.year === slot.year);
  const banner = el.querySelector('#nextBanner');
  const slotTxt = slotLabel(slot);
  const deadTxt = deadlineLabel(slot);
  if (!mine) {
    banner.innerHTML = `
      <section class="next-banner todo">
        <div class="text">
          <p class="eyebrow">Prochaine compil</p>
          <div class="head">${slotTxt}</div>
          <div class="sub">À rendre avant le ${deadTxt} — tu n'as encore rien envoyé.</div>
        </div>
        <a class="cta" href="/upload">Commencer</a>
      </section>
    `;
  } else if (mine.status !== 'published') {
    banner.innerHTML = `
      <section class="next-banner wip">
        <div class="text">
          <p class="eyebrow">Prochaine compil — en cours</p>
          <div class="head">${escape(mine.title || slotTxt)}</div>
          <div class="sub">${mine.trackCount || 0} morceau${(mine.trackCount || 0) > 1 ? 'x' : ''} déjà déposés · à rendre avant le ${deadTxt}.</div>
        </div>
        <a class="cta" href="/c/${mine.id}">Reprendre</a>
      </section>
    `;
  } else {
    banner.innerHTML = `
      <section class="next-banner done">
        <div class="text">
          <p class="eyebrow">Prochaine compil</p>
          <div class="head">${escape(mine.title)} · ${slotTxt}</div>
          <div class="sub">Publiée. Bravo.</div>
        </div>
        <a class="cta" href="/c/${mine.id}">Écouter</a>
      </section>
    `;
  }

  // ---- Shuffle row ----
  const shuffleRow = el.querySelector('#shuffleRow');
  const buttons = [
    { id: 'sh-all', label: '🔀 Tout en aléatoire', show: comps.length > 0, fn: async () => playQueue(await queueAllSongs(), { sourceLabel: 'Tout en aléatoire' }) },
    { id: 'sh-clean', label: 'Tout sauf les 😬', show: comps.length > 0, fn: async () => playQueue(await queueAllExceptDisliked(), { sourceLabel: 'Tout sauf les �' }) },
    { id: 'sh-liked', label: '❤️ Mes coups de cœur', show: likeCount() > 0, fn: async () => playQueue(await queueLikedSongs(), { sourceLabel: 'Mes coups de cœur' }) },
  ];
  for (const b of buttons) {
    if (!b.show) continue;
    const btn = document.createElement('button');
    btn.id = b.id;
    btn.className = 'shuffle-btn';
    btn.innerHTML = b.label;
    btn.addEventListener('click', b.fn);
    shuffleRow.appendChild(btn);
  }

  // ---- Author chips ----
  const authorEmails = Array.from(new Set(comps.map((c) => c.author).filter(Boolean))).sort();
  const chipsEl = el.querySelector('#authorChips');
  const mkChip = ({ label, active, href, avatarEmail = null }) => {
    const a = document.createElement('a');
    a.className = 'chip' + (active ? ' active' : '');
    a.href = href;
    a.innerHTML = avatarEmail
      ? `${avatarHTML(avatarEmail, { size: 'xs' })}<span>${escape(label)}</span>`
      : escape(label);
    return a;
  };
  chipsEl.appendChild(mkChip({ label: 'Tout', active: !filterAuthor, href: '/' }));
  authorEmails.forEach((email) => chipsEl.appendChild(mkChip({
    label: displayNameFor(email),
    active: email === filterAuthor,
    href: `/author/${authorSlug(email)}`,
    avatarEmail: email,
  })));

  const shown = filterAuthor ? comps.filter((c) => c.author === filterAuthor) : comps;
  el.querySelector('#empty').hidden = shown.length > 0;

  // ---- Season+year filter chips ----
  // Buckets are computed from `shown` so they intersect with the author filter:
  // narrowing to one author only offers that author's seasons/years.
  const seasonLabel = { ete: 'Été', noel: 'Noël' };
  const seasonOrder = { ete: 0, noel: 1 };
  const buckets = [];
  const seenKeys = new Set();
  for (const c of shown) {
    const y = c.year || new Date(c.createdAt?.toMillis?.() || Date.now()).getFullYear();
    const key = `${c.season || 'other'}-${y}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    buckets.push({ key, season: c.season || 'other', year: y });
  }
  buckets.sort((a, b) => {
    if (a.year !== b.year) return (b.year || 0) - (a.year || 0);
    return (seasonOrder[a.season] ?? 9) - (seasonOrder[b.season] ?? 9);
  });

  let filterKey = null;
  const matchesFilter = (c) => {
    if (!filterKey) return true;
    const y = c.year || new Date(c.createdAt?.toMillis?.() || Date.now()).getFullYear();
    return `${c.season || 'other'}-${y}` === filterKey;
  };

  const seasonChipsEl = el.querySelector('#seasonChips');
  const yearsEl = el.querySelector('#years');

  function renderSeasonChips() {
    seasonChipsEl.innerHTML = '';
    if (buckets.length < 2) return; // single bucket: nothing to filter
    const mkChip = (label, key) => {
      const a = document.createElement('a');
      a.className = 'chip' + (filterKey === key ? ' active' : '');
      a.href = '#';
      a.textContent = label;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        filterKey = key;
        renderSeasonChips();
        renderGroups();
      });
      return a;
    };
    seasonChipsEl.appendChild(mkChip('Tout', null));
    buckets.forEach((b) => {
      const lbl = `${seasonLabel[b.season] || b.season} ${b.year}`;
      seasonChipsEl.appendChild(mkChip(lbl, b.key));
    });
  }

  function renderGroups() {
    yearsEl.innerHTML = '';
    const filtered = shown.filter(matchesFilter);
    const byYear = new Map();
    for (const c of filtered) {
      const y = c.year || new Date(c.createdAt?.toMillis?.() || Date.now()).getFullYear();
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push(c);
    }
    const yearsSorted = [...byYear.keys()].sort((a, b) => b - a);

    for (const y of yearsSorted) {
      const groups = byYear.get(y);
      const winter = groups.filter((c) => c.season === 'noel');
      const summer = groups.filter((c) => c.season === 'ete');
      const other = groups.filter((c) => c.season !== 'ete' && c.season !== 'noel');
      for (const [seasonKey, list] of [['noel', winter], ['ete', summer], ['other', other]]) {
        if (list.length === 0) continue;
        const block = document.createElement('section');
        block.className = `season-block ${seasonKey === 'noel' ? 'winter' : seasonKey === 'ete' ? 'summer' : ''}`;
        const labelTxt = `${seasonLabel[seasonKey] || ''} ${y}`;
        block.innerHTML = `
          <header>
            <h2>${labelTxt}</h2>
            <span class="count">${list.length} compilation${list.length > 1 ? 's' : ''}</span>
            ${seasonKey === 'ete' || seasonKey === 'noel'
              ? `<button class="season-shuffle" title="Aléatoire ${labelTxt}" data-season="${seasonKey}" data-year="${y}">🔀</button>`
              : ''}
          </header>
          <div class="cover-grid"></div>
        `;
        const sb = block.querySelector('.season-shuffle');
        if (sb) {
          sb.addEventListener('click', async () => {
            sb.disabled = true;
            try {
              const queue = await queueSeasonYear(seasonKey, y);
              playQueue(queue, { sourceLabel: `${labelTxt} en aléatoire` });
            } finally {
              sb.disabled = false;
            }
          });
        }
        const grid = block.querySelector('.cover-grid');
        for (const c of list) {
          const card = document.createElement('div');
          card.className = 'cover-card';
          const firstChar = (c.title || '?')[0].toUpperCase();
          card.innerHTML = `
            <a class="cover-card-art" href="/c/${c.id}">
              <div class="art ${c.coverPath ? '' : 'placeholder'}">${c.coverPath ? '' : firstChar}</div>
              <div class="title">${escape(c.title)}</div>
            </a>
            <a class="cover-card-author" href="/author/${authorSlug(c.author)}">
              ${avatarHTML(c.author, { size: 'xs' })}
              <span class="author">${escape(displayNameFor(c.author))}</span>
            </a>
          `;
          grid.appendChild(card);
          if (c.coverPath) {
            const art = card.querySelector('.art');
            art.dataset.coverPath = c.coverPath;
            coverObserver.observe(art);
          }
        }
        yearsEl.appendChild(block);
      }
    }
    paintAvatars(el);
  }

  renderSeasonChips();
  renderGroups();
}
