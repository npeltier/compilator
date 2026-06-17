// Home view: next-slot banner, author chips, cover grid grouped by year+season,
// plus the cross-compilation shuffle buttons and the emoji tag filter.

import { auth } from '../firebase-init.js';
import { nextCompilationSlot, slotLabel, deadlineLabel } from '../slot.js';
import { visibleCompilations, displayNameFor } from '../catalog.js';
import { getMyEmojis, myEmojiSongIds } from '../reactions.js';
import { likedCompCount, likedCompilationIds } from '../liked-compilations.js';
import {
  queueAllSongs,
  queueSeasonYear,
  queueCompilations,
  queueByMyEmojis,
} from '../shuffle.js';
import { playQueue } from '../player.js';
import { coverUrl } from '../image-url.js';
import { avatarHTML, paintAvatars } from '../avatar.js';
import { filterBarHTML, wireFilterBar } from '../filter-bar.js';
import { renderPalette } from '../reaction-control.js';

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
      coverUrl(path).then((url) => { if (url) entry.target.style.backgroundImage = `url(${url})`; });
    }
  }
}, { rootMargin: '200px' });

export async function mount(el, { query }) {
  const filterAuthor = query.author || null;
  el.innerHTML = `
    <div class="shell">
      <div id="nextBanner"></div>
      <div class="shuffle-row" id="shuffleRow"></div>
      ${filterBarHTML(`
        <div class="chip-row" id="authorChips"></div>
        <div class="chip-row" id="seasonChips"></div>
        <div class="chip-row emoji-filter-row" id="emojiFilterRow">
          <span class="emoji-filter-label">Mes tags&nbsp;:</span>
          <div class="emoji-filter-chips" id="emojiFilterChips"></div>
        </div>
      `)}
      <div id="empty" class="notice" hidden>Aucune compilation pour l'instant. <a href="/upload">Crée la première</a>.</div>
      <div id="years"></div>
    </div>
  `;

  const user = auth.currentUser;
  const emailKey = user.email.toLowerCase();
  const comps = visibleCompilations()
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
        <a class="cta" href="/upload">Reprendre</a>
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
    { id: 'sh-liked-comps', label: '❤️ Mes compilations aimées', show: likedCompCount() > 0, fn: async () => playQueue(await queueCompilations(likedCompilationIds()), { sourceLabel: 'Mes compilations aimées' }) },
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

  // ---- Multi-select filters (authors × season/year) ----
  // Both chip rows toggle independently; an empty set means "no constraint".
  // The grid shows compilations matching (selected authors) AND (selected
  // season/years), and the "Lire la sélection" button plays a shuffled mix of
  // exactly that set.
  const seasonLabel = { ete: 'Été', noel: 'Noël' };
  const seasonOrder = { ete: 0, noel: 1 };
  const yearOf = (c) => c.year || new Date(c.createdAt?.toMillis?.() || Date.now()).getFullYear();
  const keyOf = (c) => `${c.season || 'other'}-${yearOf(c)}`;

  const authorEmails = Array.from(new Set(comps.map((c) => c.author).filter(Boolean)))
    .sort((a, b) => displayNameFor(a).localeCompare(displayNameFor(b), 'fr'));

  // Season/year buckets span all compilations (not just the author-filtered
  // subset) so the chips stay put as you toggle authors. Each carries a label.
  const buckets = [];
  const seenKeys = new Set();
  for (const c of comps) {
    const key = keyOf(c);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    buckets.push({ key, season: c.season || 'other', year: yearOf(c) });
  }
  buckets.sort((a, b) => {
    if (a.year !== b.year) return (b.year || 0) - (a.year || 0);
    return (seasonOrder[a.season] ?? 9) - (seasonOrder[b.season] ?? 9);
  });
  const labelForKey = new Map(buckets.map((b) => [b.key, `${seasonLabel[b.season] || b.season} ${b.year}`]));

  // Seed author selection from a legacy ?author= link, if present.
  const selectedAuthors = new Set(filterAuthor && authorEmails.includes(filterAuthor) ? [filterAuthor] : []);
  const selectedKeys = new Set();
  // Emoji filter over the user's OWN tags: keep songs with ≥1 "want" emoji,
  // drop any with a "don't want" emoji. Empty sets ⇒ no constraint.
  const wantEmojis = new Set();
  const dontWantEmojis = new Set();
  const emojiFilterActive = () => wantEmojis.size > 0 || dontWantEmojis.size > 0;
  const matchesEmojiFilter = (songId) => {
    if (!emojiFilterActive()) return true;
    const mine = getMyEmojis(songId);
    for (const e of dontWantEmojis) if (mine.has(e)) return false;
    if (wantEmojis.size === 0) return true;
    for (const e of wantEmojis) if (mine.has(e)) return true;
    return false;
  };

  el.querySelector('#empty').hidden = comps.length > 0;

  const authorChipsEl = el.querySelector('#authorChips');
  const seasonChipsEl = el.querySelector('#seasonChips');
  const emojiFilterRow = el.querySelector('#emojiFilterRow');
  const emojiFilterChips = el.querySelector('#emojiFilterChips');
  const yearsEl = el.querySelector('#years');

  const filteredComps = () => comps.filter((c) =>
    (selectedAuthors.size === 0 || selectedAuthors.has(c.author))
    && (selectedKeys.size === 0 || selectedKeys.has(keyOf(c))));

  const toggle = (set, value) => { set.has(value) ? set.delete(value) : set.add(value); };

  const mkChip = ({ label, active, avatarEmail = null, onClick }) => {
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
  };

  function renderAuthorChips() {
    authorChipsEl.innerHTML = '';
    authorChipsEl.appendChild(mkChip({
      label: 'Tout', active: selectedAuthors.size === 0,
      onClick: () => { selectedAuthors.clear(); apply(); },
    }));
    authorEmails.forEach((email) => authorChipsEl.appendChild(mkChip({
      label: displayNameFor(email),
      active: selectedAuthors.has(email),
      avatarEmail: email,
      onClick: () => { toggle(selectedAuthors, email); apply(); },
    })));
  }

  function renderSeasonChips() {
    seasonChipsEl.innerHTML = '';
    if (buckets.length < 2) return; // single bucket: nothing to filter
    seasonChipsEl.appendChild(mkChip({
      label: 'Tout', active: selectedKeys.size === 0,
      onClick: () => { selectedKeys.clear(); apply(); },
    }));
    buckets.forEach((b) => seasonChipsEl.appendChild(mkChip({
      label: labelForKey.get(b.key),
      active: selectedKeys.has(b.key),
      onClick: () => { toggle(selectedKeys, b.key); apply(); },
    })));
  }

  // Emoji tag filter row. A chip per chosen emoji ("want" first, then a "−"
  // separator and the "don't want" ones), plus an "+ Ajouter" button that opens
  // the curated palette. Clicking a "want" chip demotes it to "don't want";
  // clicking a "don't want" chip removes it. The palette lives as a sibling of
  // the rebuilt chip area so re-renders don't tear it down.
  let filterPalette = null;
  const onFilterDocClick = (e) => {
    if (!filterPalette) return;
    if (filterPalette.contains(e.target) || e.target.closest('.rx-filter-add')) return;
    closeFilterPalette();
  };
  function closeFilterPalette() {
    if (filterPalette) { filterPalette.remove(); filterPalette = null; }
    document.removeEventListener('click', onFilterDocClick, true);
  }
  function refreshFilterPalette() {
    if (!filterPalette) return;
    const applied = new Set([...wantEmojis, ...dontWantEmojis]);
    filterPalette.querySelectorAll('.rx-opt').forEach((b) => {
      b.classList.toggle('applied', applied.has(b.textContent));
    });
  }
  function openFilterPalette() {
    if (filterPalette) { closeFilterPalette(); return; }
    filterPalette = renderPalette((emoji) => {
      dontWantEmojis.delete(emoji);
      if (wantEmojis.has(emoji)) wantEmojis.delete(emoji);
      else wantEmojis.add(emoji);
      apply();
      refreshFilterPalette();
    }, new Set([...wantEmojis, ...dontWantEmojis]));
    emojiFilterRow.appendChild(filterPalette);
    document.addEventListener('click', onFilterDocClick, true);
  }

  function mkEmojiChip(emoji, kind) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip emoji-chip' + (kind === 'dont' ? ' dont' : '');
    chip.innerHTML = (kind === 'dont' ? '🚫 ' : '') + emoji;
    chip.title = kind === 'want' ? 'Je veux — clic pour exclure' : 'Exclu — clic pour retirer';
    chip.addEventListener('click', () => {
      if (kind === 'want') { wantEmojis.delete(emoji); dontWantEmojis.add(emoji); }
      else { dontWantEmojis.delete(emoji); }
      apply();
      refreshFilterPalette();
    });
    return chip;
  }

  function renderEmojiFilter() {
    emojiFilterChips.innerHTML = '';
    for (const e of wantEmojis) emojiFilterChips.appendChild(mkEmojiChip(e, 'want'));
    if (dontWantEmojis.size) {
      const sep = document.createElement('span');
      sep.className = 'emoji-filter-sep';
      sep.textContent = '−';
      emojiFilterChips.appendChild(sep);
      for (const e of dontWantEmojis) emojiFilterChips.appendChild(mkEmojiChip(e, 'dont'));
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'chip rx-filter-add';
    add.textContent = emojiFilterActive() ? '＋' : '＋ Ajouter un filtre';
    add.title = 'Ajouter un emoji au filtre';
    add.addEventListener('click', (e) => { e.stopPropagation(); openFilterPalette(); });
    emojiFilterChips.appendChild(add);
  }

  // "Lire la sélection" — a shuffle button reflecting the live selection. Lives
  // in the always-visible shuffle row; hidden when nothing is filtered (the
  // "Tout en aléatoire" button already covers that case).
  const selectionBtn = document.createElement('button');
  selectionBtn.id = 'sh-selection';
  selectionBtn.className = 'shuffle-btn';
  selectionBtn.hidden = true;
  shuffleRow.insertBefore(selectionBtn, shuffleRow.firstChild);
  selectionBtn.addEventListener('click', async () => {
    const compActive = selectedAuthors.size > 0 || selectedKeys.size > 0;
    if (!compActive && !emojiFilterActive()) return;
    selectionBtn.disabled = true;
    try {
      let queue;
      if (emojiFilterActive()) {
        const compIds = compActive ? new Set(filteredComps().map((c) => c.id)) : null;
        queue = await queueByMyEmojis(wantEmojis, dontWantEmojis, compIds);
      } else {
        const matched = filteredComps();
        if (matched.length === 0) return;
        queue = await queueCompilations(matched.map((c) => c.id));
      }
      if (queue.length) playQueue(queue, { sourceLabel: selectionSourceLabel() });
    } finally {
      selectionBtn.disabled = false;
    }
  });

  function selectionSourceLabel() {
    const parts = [
      selectedAuthors.size ? [...selectedAuthors].map(displayNameFor).join(', ') : 'Tous',
      selectedKeys.size ? [...selectedKeys].map((k) => labelForKey.get(k) || k).join(', ') : 'toutes saisons',
    ];
    if (emojiFilterActive()) {
      const want = [...wantEmojis].join('');
      const dont = [...dontWantEmojis].join('');
      parts.push(`${want}${dont ? ` − ${dont}` : ''}`);
    }
    return `Sélection · ${parts.join(' · ')}`;
  }

  function renderSelectionShuffle() {
    const compActive = selectedAuthors.size > 0 || selectedKeys.size > 0;
    const active = compActive || emojiFilterActive();
    selectionBtn.hidden = !active;
    if (!active) return;
    let suffix = '';
    if (compActive && !emojiFilterActive()) {
      const n = filteredComps().length;
      selectionBtn.disabled = n === 0;
      suffix = n ? ` · ${n} compil${n > 1 ? 's' : ''}` : '';
    } else {
      selectionBtn.disabled = false;
      // Exact count is cheap only when a "want" is set (every match is tagged);
      // a "don't want"-only filter also keeps untagged songs, so skip the count.
      if (wantEmojis.size > 0) {
        const n = myEmojiSongIds().filter((id) => matchesEmojiFilter(id)).length;
        suffix = ` · ${n} morceau${n > 1 ? 'x' : ''}`;
      }
    }
    selectionBtn.innerHTML = `🔀 Lire la sélection${suffix}`;
  }

  function apply() {
    renderAuthorChips();
    renderSeasonChips();
    renderEmojiFilter();
    renderSelectionShuffle();
    renderGroups();
    paintAvatars(el);
  }

  function renderGroups() {
    yearsEl.innerHTML = '';
    const filtered = filteredComps();
    if (filtered.length === 0 && comps.length > 0) {
      yearsEl.innerHTML = '<div class="notice">Aucune compilation pour cette sélection.</div>';
      return;
    }
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
            <a class="cover-card-author" href="#" role="button" title="Filtrer par ${escape(displayNameFor(c.author))}">
              ${avatarHTML(c.author, { size: 'xs' })}
              <span class="author">${escape(displayNameFor(c.author))}</span>
            </a>
          `;
          // Clicking a card's author toggles them in the author filter (rather
          // than navigating to their profile), so you can build up a selection.
          card.querySelector('.cover-card-author').addEventListener('click', (e) => {
            e.preventDefault();
            toggle(selectedAuthors, c.author);
            apply();
          });
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
  }

  apply();
  wireFilterBar(el);
}
