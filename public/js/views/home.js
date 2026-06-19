// Home view: next-slot banner, author chips, cover grid grouped by year+season,
// plus the cross-compilation shuffle buttons and the emoji tag filter.

import { auth } from '../firebase-init.js';
import { nextCompilationSlot, slotLabel, deadlineLabel } from '../slot.js';
import { visibleCompilations, displayNameFor } from '../catalog.js';
import { getMyEmojis, myEmojiSongIds } from '../reactions.js';
import { likedCompCount, likedCompilationIds } from '../liked-compilations.js';
import {
  savedFilters,
  saveFilter,
  deleteSavedFilter,
  onChange as onSavedChange,
} from '../saved-filters.js';
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
        <div class="chip-row" id="yearChips"></div>
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

  // Saved-filter shuffle buttons (one per preset), rendered after the static
  // buttons and kept in sync as presets are added/removed.
  const savedFiltersEl = document.createElement('span');
  savedFiltersEl.className = 'saved-filters';
  shuffleRow.appendChild(savedFiltersEl);

  // ---- Unified include / exclude filter (authors × seasons × years × emojis) ----
  // Every dimension carries an `inc` set and an `exc` set; a chip cycles
  // neutral → include → exclude → neutral. The grid and the "Lire la sélection"
  // button show compilations/songs matching every include constraint (OR within
  // a dimension, AND across dimensions) and none of the exclude ones.
  const seasonLabel = { ete: 'Été', noel: 'Noël', other: 'Autre' };
  const seasonOrder = { ete: 0, noel: 1, other: 9 };
  const yearOf = (c) => c.year || new Date(c.createdAt?.toMillis?.() || Date.now()).getFullYear();
  const seasonOf = (c) => c.season || 'other';

  const authorEmails = Array.from(new Set(comps.map((c) => c.author).filter(Boolean)))
    .sort((a, b) => displayNameFor(a).localeCompare(displayNameFor(b), 'fr'));
  const seasonsPresent = Array.from(new Set(comps.map(seasonOf)))
    .sort((a, b) => (seasonOrder[a] ?? 9) - (seasonOrder[b] ?? 9));
  const yearsPresent = Array.from(new Set(comps.map(yearOf))).sort((a, b) => b - a);

  const inc = { authors: new Set(), seasons: new Set(), years: new Set(), emojis: new Set() };
  const exc = { authors: new Set(), seasons: new Set(), years: new Set(), emojis: new Set() };
  // Seed the author include from a legacy ?author= link, if present.
  if (filterAuthor && authorEmails.includes(filterAuthor)) inc.authors.add(filterAuthor);

  // Tri-state cycle: neutral → include → exclude → neutral.
  const cycle = (dim, value) => {
    if (inc[dim].has(value)) { inc[dim].delete(value); exc[dim].add(value); }
    else if (exc[dim].has(value)) { exc[dim].delete(value); }
    else { inc[dim].add(value); }
    apply();
  };
  const clearDim = (dim) => { inc[dim].clear(); exc[dim].clear(); apply(); };
  const stateOf = (dim, value) => (inc[dim].has(value) ? 'inc' : exc[dim].has(value) ? 'exc' : null);
  const dimEmpty = (dim) => inc[dim].size === 0 && exc[dim].size === 0;

  const emojiFilterActive = () => inc.emojis.size > 0 || exc.emojis.size > 0;
  const matchesEmojiFilter = (songId) => {
    if (!emojiFilterActive()) return true;
    const mine = getMyEmojis(songId);
    for (const e of exc.emojis) if (mine.has(e)) return false;
    if (inc.emojis.size === 0) return true;
    for (const e of inc.emojis) if (mine.has(e)) return true;
    return false;
  };

  el.querySelector('#empty').hidden = comps.length > 0;

  const authorChipsEl = el.querySelector('#authorChips');
  const seasonChipsEl = el.querySelector('#seasonChips');
  const yearChipsEl = el.querySelector('#yearChips');
  const emojiFilterRow = el.querySelector('#emojiFilterRow');
  const emojiFilterChips = el.querySelector('#emojiFilterChips');
  const yearsEl = el.querySelector('#years');

  const filteredComps = () => comps.filter((c) => {
    const a = c.author, s = seasonOf(c), y = yearOf(c);
    if (exc.authors.has(a) || exc.seasons.has(s) || exc.years.has(y)) return false;
    if (inc.authors.size && !inc.authors.has(a)) return false;
    if (inc.seasons.size && !inc.seasons.has(s)) return false;
    if (inc.years.size && !inc.years.has(y)) return false;
    return true;
  });

  // Tri-state chip: include renders filled (.active), exclude renders dashed
  // with a 🚫 prefix (.exc), neutral is plain. Clicking advances the cycle.
  const mkChip = ({ label, state, avatarEmail = null, onClick }) => {
    const a = document.createElement('a');
    a.className = 'chip' + (state === 'inc' ? ' active' : state === 'exc' ? ' exc' : '');
    a.href = '#';
    a.setAttribute('role', 'button');
    a.setAttribute('aria-pressed', String(state === 'inc'));
    const inner = avatarEmail
      ? `${avatarHTML(avatarEmail, { size: 'xs' })}<span>${escape(label)}</span>`
      : `<span>${escape(label)}</span>`;
    a.innerHTML = (state === 'exc' ? '🚫 ' : '') + inner;
    a.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
    return a;
  };

  function renderAuthorChips() {
    authorChipsEl.innerHTML = '';
    authorChipsEl.appendChild(mkChip({
      label: 'Tout', state: dimEmpty('authors') ? 'inc' : null,
      onClick: () => clearDim('authors'),
    }));
    authorEmails.forEach((email) => authorChipsEl.appendChild(mkChip({
      label: displayNameFor(email),
      state: stateOf('authors', email),
      avatarEmail: email,
      onClick: () => cycle('authors', email),
    })));
  }

  function renderSeasonChips() {
    seasonChipsEl.innerHTML = '';
    if (seasonsPresent.length < 2) return; // nothing to filter
    seasonChipsEl.appendChild(mkChip({
      label: 'Tout', state: dimEmpty('seasons') ? 'inc' : null,
      onClick: () => clearDim('seasons'),
    }));
    seasonsPresent.forEach((s) => seasonChipsEl.appendChild(mkChip({
      label: seasonLabel[s] || s,
      state: stateOf('seasons', s),
      onClick: () => cycle('seasons', s),
    })));
  }

  function renderYearChips() {
    yearChipsEl.innerHTML = '';
    if (yearsPresent.length < 2) return; // nothing to filter
    yearChipsEl.appendChild(mkChip({
      label: 'Tout', state: dimEmpty('years') ? 'inc' : null,
      onClick: () => clearDim('years'),
    }));
    yearsPresent.forEach((y) => yearChipsEl.appendChild(mkChip({
      label: String(y),
      state: stateOf('years', y),
      onClick: () => cycle('years', y),
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
    const applied = new Set([...inc.emojis, ...exc.emojis]);
    filterPalette.querySelectorAll('.rx-opt').forEach((b) => {
      b.classList.toggle('applied', applied.has(b.textContent));
    });
  }
  // Open the curated palette, adding picks to either the include or exclude
  // list. Re-opening with the same target toggles it closed.
  let paletteTarget = null;
  function openFilterPalette(target) {
    if (filterPalette && paletteTarget === target) { closeFilterPalette(); return; }
    if (filterPalette) closeFilterPalette();
    paletteTarget = target;
    const into = target === 'exc' ? exc.emojis : inc.emojis;
    const other = target === 'exc' ? inc.emojis : exc.emojis;
    filterPalette = renderPalette((emoji) => {
      other.delete(emoji);
      if (into.has(emoji)) into.delete(emoji);
      else into.add(emoji);
      apply();
      refreshFilterPalette();
    }, new Set([...inc.emojis, ...exc.emojis]));
    emojiFilterRow.appendChild(filterPalette);
    document.addEventListener('click', onFilterDocClick, true);
  }

  function mkEmojiChip(emoji, kind) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip emoji-chip' + (kind === 'exc' ? ' dont' : '');
    chip.innerHTML = (kind === 'exc' ? '🚫 ' : '') + emoji;
    chip.title = kind === 'inc' ? 'Inclus — clic pour retirer' : 'Exclu — clic pour retirer';
    chip.addEventListener('click', () => {
      (kind === 'exc' ? exc.emojis : inc.emojis).delete(emoji);
      apply();
      refreshFilterPalette();
    });
    return chip;
  }

  function mkAddButton(label, target) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'chip rx-filter-add';
    add.textContent = label;
    add.title = target === 'exc' ? 'Ajouter un emoji à exclure' : 'Ajouter un emoji à inclure';
    add.addEventListener('click', (e) => { e.stopPropagation(); openFilterPalette(target); });
    return add;
  }

  function renderEmojiFilter() {
    emojiFilterChips.innerHTML = '';
    for (const e of inc.emojis) emojiFilterChips.appendChild(mkEmojiChip(e, 'inc'));
    if (exc.emojis.size) {
      const sep = document.createElement('span');
      sep.className = 'emoji-filter-sep';
      sep.textContent = '−';
      emojiFilterChips.appendChild(sep);
      for (const e of exc.emojis) emojiFilterChips.appendChild(mkEmojiChip(e, 'exc'));
    }
    emojiFilterChips.appendChild(mkAddButton('＋ inclure', 'inc'));
    emojiFilterChips.appendChild(mkAddButton('＋ exclure', 'exc'));
  }

  const dimActive = (d) => inc[d].size > 0 || exc[d].size > 0;
  const compFilterActive = () => dimActive('authors') || dimActive('seasons') || dimActive('years');
  const filterActive = () => compFilterActive() || emojiFilterActive();

  // Canonical "+ list − − list" label, reused for the player source line and
  // saved-filter auto-names, e.g. "Nicolas P. ❤️🕺 − 👎😬".
  function filterLabel() {
    const side = (bag) => {
      const parts = [
        ...[...bag.authors].map(displayNameFor),
        ...[...bag.seasons].map((s) => seasonLabel[s] || s),
        ...[...bag.years].map(String),
      ];
      const emojis = [...bag.emojis].join('');
      if (emojis) parts.push(emojis);
      return parts.join(' ');
    };
    const inStr = side(inc);
    const outStr = side(exc);
    return outStr ? `${inStr || 'Tout'} − ${outStr}` : (inStr || 'Tout');
  }

  const bagToArrays = (bag) => ({
    authors: [...bag.authors],
    seasons: [...bag.seasons],
    years: [...bag.years].map(String),
    emojis: [...bag.emojis],
  });

  // Order-independent signature of a { authors, seasons, years, emojis } shape,
  // used to tell whether the live selection equals an already-saved preset.
  const sideSig = (side) => ['authors', 'seasons', 'years', 'emojis']
    .map((d) => [...(side[d] || [])].map(String).sort().join(','))
    .join('|');
  const liveSig = () => `${sideSig(bagToArrays(inc))}#${sideSig(bagToArrays(exc))}`;
  // True when the live selection exactly matches one of the saved presets, in
  // which case it's already playable/saved via its own chip — no need for the
  // "Lire la sélection" / 💾 buttons.
  const matchesSavedFilter = () => {
    const cur = liveSig();
    return savedFilters().some((f) => `${sideSig(f.inc)}#${sideSig(f.exc)}` === cur);
  };

  // Resolve the live filter to a shuffled queue. Author/season/year narrow the
  // compilation set; emoji include/exclude narrow songs within it.
  async function buildQueueFor() {
    const compIds = compFilterActive() ? new Set(filteredComps().map((c) => c.id)) : null;
    if (emojiFilterActive()) return queueByMyEmojis(inc.emojis, exc.emojis, compIds);
    return queueCompilations([...(compIds || [])]);
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
    if (!filterActive()) return;
    selectionBtn.disabled = true;
    try {
      const queue = await buildQueueFor();
      if (queue.length) playQueue(queue, { sourceLabel: filterLabel() });
    } finally {
      selectionBtn.disabled = false;
    }
  });

  // "💾" — save the live filter as a preset, auto-named from the filter itself.
  const saveBtn = document.createElement('button');
  saveBtn.id = 'sh-save';
  saveBtn.className = 'shuffle-btn save-btn';
  saveBtn.innerHTML = '💾';
  saveBtn.title = 'Enregistrer ce filtre';
  saveBtn.hidden = true;
  shuffleRow.insertBefore(saveBtn, selectionBtn.nextSibling);
  saveBtn.addEventListener('click', async () => {
    if (!filterActive()) return;
    saveBtn.disabled = true;
    try {
      await saveFilter({ name: filterLabel(), inc: bagToArrays(inc), exc: bagToArrays(exc) });
    } finally {
      saveBtn.disabled = false;
    }
  });

  function renderSelectionShuffle() {
    const active = filterActive() && !matchesSavedFilter();
    selectionBtn.hidden = !active;
    saveBtn.hidden = !active;
    if (!active) return;
    let suffix = '';
    if (compFilterActive() && !emojiFilterActive()) {
      const n = filteredComps().length;
      selectionBtn.disabled = n === 0;
      suffix = n ? ` · ${n} compil${n > 1 ? 's' : ''}` : '';
    } else {
      selectionBtn.disabled = false;
      // Exact count is cheap only when an include emoji is set (every match is
      // tagged); an exclude-only filter also keeps untagged songs, so skip it.
      if (inc.emojis.size > 0) {
        const n = myEmojiSongIds().filter((id) => matchesEmojiFilter(id)).length;
        suffix = ` · ${n} morceau${n > 1 ? 'x' : ''}`;
      }
    }
    selectionBtn.innerHTML = `🔀 Lire la sélection${suffix}`;
  }

  // Rehydrate a saved preset's arrays into the live inc/exc Sets (years back to
  // numbers) and refresh the UI.
  function applySavedFilter(f) {
    for (const dim of ['authors', 'seasons', 'years', 'emojis']) { inc[dim].clear(); exc[dim].clear(); }
    const load = (bag, src) => {
      for (const a of src?.authors || []) bag.authors.add(a);
      for (const s of src?.seasons || []) bag.seasons.add(s);
      for (const y of src?.years || []) bag.years.add(Number(y));
      for (const e of src?.emojis || []) bag.emojis.add(e);
    };
    load(inc, f.inc); load(exc, f.exc);
    apply();
  }

  function renderSavedFilters() {
    savedFiltersEl.innerHTML = '';
    for (const f of savedFilters()) {
      const wrap = document.createElement('span');
      wrap.className = 'saved-filter';
      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'shuffle-btn sf-play';
      play.innerHTML = `🔀 ${escape(f.name || 'Filtre')}`;
      play.title = 'Jouer ce filtre';
      play.addEventListener('click', async () => {
        play.disabled = true;
        try {
          applySavedFilter(f);
          const queue = await buildQueueFor();
          if (queue.length) playQueue(queue, { sourceLabel: f.name || filterLabel() });
        } finally {
          play.disabled = false;
        }
      });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'sf-del';
      del.innerHTML = '×';
      del.title = 'Supprimer ce filtre';
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteSavedFilter(f.id); });
      wrap.appendChild(play);
      wrap.appendChild(del);
      savedFiltersEl.appendChild(wrap);
    }
  }

  function apply() {
    renderAuthorChips();
    renderSeasonChips();
    renderYearChips();
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
      for (const [seasonKey, list] of [['ete', summer], ['noel', winter], ['other', other]]) {
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
            cycle('authors', c.author);
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
  renderSavedFilters();
  wireFilterBar(el);

  // Keep the saved-filter buttons in sync as presets are added/removed, and
  // tear the subscription (and any open palette) down when the view unmounts.
  const offSaved = onSavedChange(() => { renderSavedFilters(); renderSelectionShuffle(); });
  return () => { offSaved(); closeFilterPalette(); };
}
