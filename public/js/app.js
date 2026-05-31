// SPA shell boot. Wires auth-guard, loads catalog + reactions, mounts the
// router, and renders the persistent player bar.

import { requireAuth, logout } from './auth-guard.js';
import { loadCatalog } from './catalog.js';
import { loadReactions } from './reactions.js';
import { initPlayer } from './player.js';
import { register, start } from './router.js';

document.getElementById('logout').addEventListener('click', (e) => { e.preventDefault(); logout(); });

const user = await requireAuth();
document.getElementById('who').textContent = user.email;

// Boot data — block first render until the catalog and reactions are available.
// All views read from these caches and assume they're populated.
await Promise.all([
  loadCatalog(),
  loadReactions(user.uid),
]);

initPlayer();

register('/', () => import('./views/home.js'));
register('/c/:id', () => import('./views/compilation.js'));
register('/upload', () => import('./views/upload.js'));
register('/profile', () => import('./views/profile.js'));
register('/migrate', () => import('./views/migrate.js'));
register('/author/:name', () => import('./views/author.js'));

start(document.getElementById('view'));
