// SPA shell boot. Wires auth-guard, loads catalog + reactions, mounts the
// router, and renders the persistent player bar.

import { isAdminSync, requireAuth, logout } from './auth-guard.js';
import { ensureSongsLoaded, loadAllowlist, loadCatalog } from './catalog.js';
import { loadReactions } from './reactions.js';
import { initPlayer } from './player.js';
import { register, start } from './router.js';

document.getElementById('logout').addEventListener('click', (e) => { e.preventDefault(); logout(); });

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
document.getElementById('who').textContent = user.email;

// Boot data — block first render until the catalog and reactions are available.
// All views read from these caches and assume they're populated.
await Promise.all([
  loadCatalog(),
  loadReactions(user.email),
  // Allowlist is admin-readable only; non-admins skip the fetch (rules would
  // reject it anyway). Used to populate "assign author" dropdowns with users
  // who haven't signed in yet.
  isAdminSync(user.email) ? loadAllowlist().catch(() => {}) : null,
]);

initPlayer();
ensureSongsLoaded(); // warm in background; not awaited — shuffle buttons await it on click

register('/', () => import('./views/home.js'));
register('/c/:id', () => import('./views/compilation.js'));
register('/upload', () => import('./views/upload.js'));
register('/profile', () => import('./views/profile.js'));
register('/migrate', () => import('./views/migrate.js'));
register('/users', () => import('./views/users.js'));
register('/author/:name', () => import('./views/author.js'));

start(document.getElementById('view'));
