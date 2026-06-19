// Shared emoji-reaction UI control, used by both the compilation track rows and
// the player bar so the markup and behaviour live in one place.
//
// A control has two parts:
//   • an aggregate strip (.rx-strip) of community emoji chips with counts, where
//     hovering (title) or tapping a chip reveals who reacted; and
//   • a "+" picker button (.rx-add) opening a popover palette (.rx-palette) of
//     the curated EMOJIS, where the user toggles their own emojis (multi-select).

import { auth } from './firebase-init.js';
import { EMOJIS, getMyEmojis, toggleEmoji, onChange } from './reactions.js';
import { getAggregate } from './community-reactions.js';
import { displayNameFor } from './catalog.js';

// Only one palette open at a time across the page.
let closeOpenPalette = null;

// Build a palette popover. `onPick(emoji)` fires on click; `appliedSet` (optional)
// marks emojis already chosen. Reused by the home emoji filter.
export function renderPalette(onPick, appliedSet) {
  const pal = document.createElement('div');
  pal.className = 'rx-palette';
  for (const emoji of EMOJIS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rx-opt' + (appliedSet?.has(emoji) ? ' applied' : '');
    b.textContent = emoji;
    b.addEventListener('click', (e) => { e.stopPropagation(); onPick(emoji); });
    pal.appendChild(b);
  }
  return pal;
}

export function createReactionControl(songId, { compact = false } = {}) {
  const el = document.createElement('div');
  el.className = 'rx' + (compact ? ' compact' : '');

  const strip = document.createElement('div');
  strip.className = 'rx-strip';

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'rx-add';
  addBtn.title = 'Réagir';
  addBtn.setAttribute('aria-label', 'Réagir');
  addBtn.setAttribute('aria-expanded', 'false');
  addBtn.textContent = '+';

  el.append(strip, addBtn);

  let palette = null;
  let tooltip = null;

  function onDocClick(e) { if (!el.contains(e.target)) closePalette(); }
  function onKey(e) { if (e.key === 'Escape') closePalette(); }

  function closePalette() {
    if (palette) { palette.remove(); palette = null; }
    addBtn.setAttribute('aria-expanded', 'false');
    if (closeOpenPalette === closePalette) closeOpenPalette = null;
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onKey);
  }

  function openPalette() {
    if (closeOpenPalette) closeOpenPalette();
    palette = renderPalette((emoji) => { toggleEmoji(songId, emoji); closePalette(); }, getMyEmojis(songId));
    el.appendChild(palette);
    addBtn.setAttribute('aria-expanded', 'true');
    closeOpenPalette = closePalette;
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKey);
  }

  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (palette) closePalette();
    else openPalette();
  });

  function hideTooltip() {
    if (tooltip) { tooltip.remove(); tooltip = null; }
  }
  function toggleTooltip(names) {
    if (tooltip) { hideTooltip(); return; }
    tooltip = document.createElement('div');
    tooltip.className = 'rx-tooltip';
    tooltip.textContent = names;
    el.appendChild(tooltip);
    const close = (e) => {
      if (!tooltip || tooltip.contains(e.target)) return;
      hideTooltip();
      document.removeEventListener('click', close, true);
    };
    document.addEventListener('click', close, true);
  }

  function refresh() {
    const me = (auth.currentUser?.email || '').toLowerCase();
    strip.innerHTML = '';
    for (const { emoji, users } of getAggregate(songId)) {
      const names = users.map(displayNameFor).join(', ');
      const chip = document.createElement('button');
      chip.type = 'button';
      const isMine = users.includes(me);
      chip.className = 'rx-chip' + (isMine ? ' mine' : '');
      chip.title = names;
      chip.setAttribute('aria-label', `${emoji} : ${names}`);
      chip.innerHTML = `<span class="rx-emo">${emoji}</span>`
        + (users.length > 1 ? `<span class="rx-count">${users.length}</span>` : '');
      // Clicking my own reaction removes it; clicking someone else's reveals who reacted.
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isMine) toggleEmoji(songId, emoji);
        else toggleTooltip(names);
      });
      strip.appendChild(chip);
    }
    if (palette) {
      const applied = getMyEmojis(songId);
      palette.querySelectorAll('.rx-opt').forEach((b) => {
        b.classList.toggle('applied', applied.has(b.textContent));
      });
    }
  }

  const off = onChange((changedId) => { if (changedId === songId) refresh(); });
  refresh();

  return {
    el,
    refresh,
    unsub: () => { off(); closePalette(); hideTooltip(); },
  };
}
