// Global top-bar search. Matches against compilation titles, author display
// names, and song title/artist — all from the in-memory catalog, so it's
// instant once the catalog (and, for songs, the lazy songs payload) is loaded.
//
// Results drop down under the (sticky) top bar. Picking a result:
//   - compilation → navigate to /c/:id
//   - author      → navigate to /author/:slug
//   - song        → play its compilation starting at that track

import {
  visibleCompilations,
  visibleSongs,
  authorSlug,
  displayNameFor,
  ensureSongsLoaded,
  trackFromSongId,
} from './catalog.js';
import { playQueue } from './player.js';
import { navigate } from './router.js';
import { avatarHTML, paintAvatars } from './avatar.js';

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Diacritic-insensitive, case-insensitive normalization for matching.
function norm(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const MAX_PER_GROUP = 6;

export function initSearch() {
  const input = document.getElementById('searchInput');
  const panel = document.getElementById('searchResults');
  if (!input || !panel) return;

  let songsReady = false;
  // Songs are warmed in the background at boot; make sure they're in before we
  // search, and re-render once they arrive if the user is mid-query.
  const warmSongs = () => {
    if (songsReady) return;
    ensureSongsLoaded().then(() => {
      songsReady = true;
      if (input.value.trim()) render();
    }).catch(() => {});
  };

  function close() { panel.hidden = true; panel.innerHTML = ''; }

  function pickCompilation(id) { close(); input.value = ''; input.blur(); navigate(`/c/${id}`); }
  function pickAuthor(email) { close(); input.value = ''; input.blur(); navigate(`/author/${authorSlug(email)}`); }
  function pickSong(songId) {
    const t = trackFromSongId(songId);
    if (!t) return;
    const queue = visibleSongs()
      .filter((s) => s.compilationId === t.compilationId)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((s) => trackFromSongId(s.id))
      .filter(Boolean);
    const startIndex = Math.max(0, queue.findIndex((x) => x.songId === songId));
    close(); input.value = ''; input.blur();
    playQueue(queue, { startIndex, sourceLabel: t.compilationTitle });
  }

  function render() {
    const q = norm(input.value.trim());
    if (!q) { close(); return; }

    const comps = visibleCompilations()
      .filter((c) => norm(c.title).includes(q))
      .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0))
      .slice(0, MAX_PER_GROUP);

    const authorEmails = [...new Set(visibleCompilations().map((c) => c.author).filter(Boolean))];
    const authors = authorEmails
      .filter((e) => norm(displayNameFor(e)).includes(q))
      .sort((a, b) => displayNameFor(a).localeCompare(displayNameFor(b), 'fr'))
      .slice(0, MAX_PER_GROUP);

    const songs = visibleSongs()
      .filter((s) => norm(s.title).includes(q) || norm(s.artist).includes(q))
      .slice(0, MAX_PER_GROUP)
      .map((s) => trackFromSongId(s.id))
      .filter(Boolean);

    panel.innerHTML = '';

    if (!comps.length && !authors.length && !songs.length) {
      panel.innerHTML = songsReady
        ? '<div class="search-empty">Aucun résultat.</div>'
        : '<div class="search-empty">Recherche en cours…</div>';
      panel.hidden = false;
      return;
    }

    if (comps.length) {
      panel.appendChild(group('Compilations', comps.map((c) => item({
        icon: iconArt(c),
        title: c.title,
        sub: displayNameFor(c.author),
        onClick: () => pickCompilation(c.id),
      }))));
    }
    if (authors.length) {
      panel.appendChild(group('Auteurs', authors.map((e) => item({
        iconHTML: avatarHTML(e, { size: 'sm' }),
        title: displayNameFor(e),
        onClick: () => pickAuthor(e),
      }))));
    }
    if (songs.length) {
      panel.appendChild(group('Morceaux', songs.map((t) => item({
        icon: '♪',
        title: t.title,
        sub: [t.artist, t.compilationTitle].filter(Boolean).join(' · '),
        onClick: () => pickSong(t.songId),
      }))));
    }

    panel.hidden = false;
    paintAvatars(panel);
  }

  function group(label, items) {
    const wrap = document.createElement('div');
    wrap.className = 'search-group';
    const h = document.createElement('div');
    h.className = 'search-group-label';
    h.textContent = label;
    wrap.appendChild(h);
    items.forEach((el) => wrap.appendChild(el));
    return wrap;
  }

  function item({ icon, iconHTML, title, sub, onClick }) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'search-item';
    btn.innerHTML = `
      <span class="si-icon">${iconHTML ?? escape(icon ?? '')}</span>
      <span class="si-text">
        <span class="si-title">${escape(title)}</span>
        ${sub ? `<span class="si-sub">${escape(sub)}</span>` : ''}
      </span>
    `;
    btn.addEventListener('click', onClick);
    return btn;
  }

  // Tiny placeholder glyph for a compilation (first letter of its title).
  function iconArt(c) { return (c.title || '?')[0].toUpperCase(); }

  input.addEventListener('focus', warmSongs, { once: true });
  input.addEventListener('focus', render);
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = ''; close(); input.blur(); }
  });

  // Dismiss when clicking anywhere outside the search box.
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.topbar-search')) close();
  });
}
