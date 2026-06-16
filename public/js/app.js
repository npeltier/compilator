// SPA shell boot. Wires auth-guard, loads catalog + reactions, mounts the
// router, and renders the persistent player bar.

import { isAdminSync, requireAuth } from './auth-guard.js';
import { avatarHTML, paintAvatars } from './avatar.js';
import { displayNameFor, setViewer } from './catalog.js';
import { ensureSongsLoaded, loadAllowlist, loadCatalog } from './catalog.js';
import { loadReactions } from './reactions.js';
import { loadLikedCompilations } from './liked-compilations.js';
import { initPlayer } from './player.js';
import { initSearch } from './search.js';
import { register, start } from './router.js';

// Surface the build version on the brand's tooltip and log it. CI rewrites the
// meta tags below before `firebase deploy`; locally they read "dev".
{
  const commit = document.querySelector('meta[name="build-commit"]')?.content || 'unknown';
  const time = document.querySelector('meta[name="build-time"]')?.content || 'unknown';
  const brand = document.querySelector('.brand');
  if (brand) brand.title = `build ${commit} · ${time}`;
  console.info(`Compilator build ${commit} · ${time}`);
}

const user = await requireAuth();

// Boot data — block first render until the catalog and reactions are available.
// All views read from these caches and assume they're populated.
await Promise.all([
  loadCatalog(),
  loadReactions(user.email),
  loadLikedCompilations(user.email),
  // Allowlist is admin-readable only; non-admins skip the fetch (rules would
  // reject it anyway). Used to populate "assign author" dropdowns with users
  // who haven't signed in yet.
  isAdminSync(user.email) ? loadAllowlist().catch(() => {}) : null,
]);

// Tell the catalog who's viewing so it can hide other people's draft
// compilations from listings / search / shuffle.
setViewer(user.email, isAdminSync(user.email));

// Profile link in the top nav: avatar + display name. Rendered after the
// catalog loads so getUser() resolves the user's avatarPath; paintAvatars then
// fetches the image. Re-rendered on `profile-updated` (dispatched by the
// profile view after an avatar / name change) so the nav stays in sync.
function renderWho() {
  const who = document.getElementById('who');
  who.innerHTML = `${avatarHTML(user.email, { size: 'sm' })}<span class="who-name"></span>`;
  who.querySelector('.who-name').textContent = displayNameFor(user.email);
  paintAvatars(who);
}
renderWho();
window.addEventListener('profile-updated', renderWho);

// Keep --topbar-h in sync so the sticky filter bar parks just below the nav
// (the nav wraps to a taller layout on phones).
const topbar = document.querySelector('.topbar');
if (topbar) {
  const setTopbarH = () => document.documentElement.style.setProperty('--topbar-h', `${topbar.offsetHeight}px`);
  setTopbarH();
  new ResizeObserver(setTopbarH).observe(topbar);
}

initPlayer();
initSearch();
ensureSongsLoaded(); // warm in background; not awaited — shuffle buttons await it on click

register('/', () => import('./views/home.js'));
register('/c/:id', () => import('./views/compilation.js'));
register('/upload', () => import('./views/upload.js'));
register('/profile', () => import('./views/profile.js'));
register('/migrate', () => import('./views/migrate.js'));
register('/users', () => import('./views/users.js'));
register('/author/:name', () => import('./views/author.js'));

start(document.getElementById('view'));
