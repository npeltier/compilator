// Notifications dropdown in the top nav: a count badge over the profile avatar,
// a panel listing recent activity, and a one-shot toast on load. Clicking the
// avatar opens the panel (and marks everything seen); a footer link keeps the
// profile-settings page reachable now that the avatar is a menu trigger.
//
// Data comes from notifications.js (feed + unread cut + seen marker); this module
// is presentation + wiring only.

import { avatarHTML, paintAvatars } from './avatar.js';
import { authorSlug, displayNameFor } from './catalog.js';
import { showToast } from './toast.js';
import {
  currentCut,
  getFeed,
  loadNotifications,
  markSeen,
  unreadCount,
} from './notifications.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Singleton control surface, set once by initNotifications — lets the admin
// /notif-test page refresh the badge and open the panel after injecting samples.
let controller = null;
export function notifMenu() { return controller; }

export function initNotifications(user) {
  const wrap = document.getElementById('whoWrap');
  const trigger = document.getElementById('who');
  const badge = document.getElementById('notifBadge');
  const panel = document.getElementById('notifPanel');
  if (!wrap || !trigger || !badge || !panel) return;

  let open = false;

  function setBadge(n) {
    if (n > 0) { badge.textContent = n > 99 ? '99+' : String(n); badge.hidden = false; }
    else { badge.hidden = true; }
    trigger.setAttribute('aria-label', n > 0 ? `Profil — ${n} notifications` : 'Profil');
  }

  function onDocClick(e) {
    if (!wrap.contains(e.target)) closePanel();      // click outside → close
    else if (e.target.closest('a')) closePanel();    // followed a link → close, let router navigate
  }
  function onKey(e) { if (e.key === 'Escape') closePanel(); }

  function openPanel() {
    if (open) return;
    open = true;
    trigger.setAttribute('aria-expanded', 'true');
    renderPanel();        // highlights use the pre-mark cut
    panel.hidden = false;
    markSeen();           // advance cut + persist; badge → 0
    setBadge(0);
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKey);
  }
  function closePanel() {
    if (!open) return;
    open = false;
    trigger.setAttribute('aria-expanded', 'false');
    panel.hidden = true;
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onKey);
  }

  trigger.addEventListener('click', (e) => {
    e.preventDefault();
    open ? closePanel() : openPanel();
  });

  // Expose a minimal control surface for the admin test page.
  controller = {
    openPanel,
    // Reflect the current feed's unread count on the badge (and re-render if open).
    refresh() { setBadge(unreadCount()); if (open) renderPanel(); },
  };

  function renderPanel() {
    const feed = getFeed();
    const cut = currentCut();
    const foot = `<a class="notif-foot" href="/profile">Profil &amp; réglages</a>`;
    if (!feed.length) {
      panel.innerHTML = `<div class="notif-head">Notifications</div>`
        + `<div class="notif-empty">Rien de neuf pour l'instant.</div>${foot}`;
      return;
    }
    const rows = feed.map((e) => renderRow(e, e.ts > cut)).join('');
    panel.innerHTML = `<div class="notif-head">Notifications</div>`
      + `<ul class="notif-list">${rows}</ul>${foot}`;
    paintAvatars(panel);
  }

  function renderRow(e, unread) {
    const u = unread ? ' unread' : '';
    if (e.type === 'reaction') {
      const t = e.track;
      const compLink = t.compilationId
        ? ` · <a href="/c/${t.compilationId}">${esc(t.compilationTitle)}</a>` : '';
      return `<li class="notif-row${u}">`
        + `<a class="notif-who" href="/author/${esc(authorSlug(e.reactor))}">`
        + `${avatarHTML(e.reactor, { size: 'xs' })}<span>${esc(displayNameFor(e.reactor))}</span></a>`
        + `<span class="notif-emoji">${esc(e.emojis.join(' '))}</span>`
        + `<div class="notif-txt">sur <span class="notif-track">${esc(t.title)}</span>${compLink}</div>`
        + `</li>`;
    }
    const c = e.comp;
    return `<li class="notif-row${u}">`
      + `<div class="notif-txt">Nouvelle compilation `
      + `<a href="/c/${c.id}">${esc(c.title || 'Sans titre')}</a> de `
      + `<a href="/author/${esc(authorSlug(c.author))}">${esc(displayNameFor(c.author))}</a></div>`
      + `</li>`;
  }

  // Background load — never blocks boot. Then reflect the count and toast once.
  loadNotifications(user.email).then(() => {
    const n = unreadCount();
    setBadge(n);
    if (n > 0) {
      const s = n > 1 ? 's' : '';
      showToast(`Tu as ${n} nouvelle${s} notification${s}`, { onClick: openPanel });
    }
  }).catch((err) => console.warn('notifications load failed', err));
}
