// SPA shell boot. Wires auth-guard, loads catalog + reactions, mounts the
// router, and renders the persistent player bar.

import { isAdminSync, requireAuth } from './auth-guard.js';
import { avatarHTML, paintAvatars } from './avatar.js';
import { displayNameFor, setViewer } from './catalog.js';
import { ensureSongsLoaded, loadAllowlist, loadCatalog, seedTestAuthors } from './catalog.js';
import { loadReactions } from './reactions.js';
import { ensureCommunityReactionsLoaded } from './community-reactions.js';
import { loadLikedCompilations } from './liked-compilations.js';
import { loadSavedFilters } from './saved-filters.js';
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

// ---- boot overlay ----
// Keeps the user off a blank page while the shell fetches its critical data,
// and turns a failed boot (dead network, Firestore hiccup) into a spinner →
// retry → reportable message instead of a silent black screen.
const boot = document.createElement('div');
boot.className = 'boot-overlay';
boot.setAttribute('role', 'status');
boot.setAttribute('aria-live', 'polite');
document.body.appendChild(boot);

function bootLoading(msg = 'Chargement…') {
  boot.className = 'boot-overlay';
  boot.innerHTML = `<div class="boot-box"><div class="boot-spinner" aria-hidden="true"></div><div class="boot-msg"></div></div>`;
  boot.querySelector('.boot-msg').textContent = msg;
}
function bootDone() { boot.remove(); }
function bootError(err) {
  // A short, copy-pasteable summary the user can report back to me.
  const report = `Compilator boot error — ${err?.code || err?.name || 'unknown'}: ${err?.message || err}`;
  boot.className = 'boot-overlay boot-overlay--error';
  boot.innerHTML = `
    <div class="boot-box">
      <div class="boot-msg boot-msg--error">Impossible de charger l'application.</div>
      <p class="boot-sub">Vérifiez votre connexion, puis réessayez.</p>
      <button class="btn" id="boot-retry">Réessayer</button>
      <pre class="boot-report"></pre>
    </div>`;
  boot.querySelector('.boot-report').textContent = report;
  boot.querySelector('#boot-retry').addEventListener('click', () => runBoot());
}

// Retry transient failures with linear backoff; surface progress in the overlay.
async function withRetry(fn, { tries = 4, base = 600 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      console.warn(`boot step failed (attempt ${attempt}/${tries})`, err);
      if (attempt < tries) {
        bootLoading(`Connexion instable, nouvelle tentative… (${attempt}/${tries - 1})`);
        await new Promise((r) => setTimeout(r, base * attempt));
      }
    }
  }
  throw lastErr;
}

let booted = false;
async function runBoot() {
  bootLoading();
  let user;
  try {
    // requireAuth resolves to the user, or (on a redirect to /login) returns a
    // promise that never settles — the page navigates away, so no retry fires.
    user = await withRetry(() => requireAuth());

    // Boot data — block first render until the catalog and reactions are
    // available. All views read from these caches and assume they're populated.
    await withRetry(() => Promise.all([
      loadCatalog(),
      loadReactions(user.email),
      loadLikedCompilations(user.email),
      loadSavedFilters(user.email),
      // Allowlist is admin-readable only; non-admins skip the fetch (rules would
      // reject it anyway). Used to populate "assign author" dropdowns with users
      // who haven't signed in yet.
      isAdminSync(user.email) ? loadAllowlist().catch(() => {}) : null,
    ]));
  } catch (err) {
    bootError(err);
    return;
  }
  bootDone();
  if (booted) return; // a retry re-ran the data load; the shell is already wired
  booted = true;
  initShell(user);
}

function initShell(user) {

// Tell the catalog who's viewing so it can hide other people's draft
// compilations from listings / search / shuffle.
setViewer(user.email, isAdminSync(user.email));

// Dev-only: `?seedAuthors=35` injects fake authors so the filter UI can be
// tested with many users (in-memory only; never persisted to Firestore).
const seedN = Number(new URLSearchParams(location.search).get('seedAuthors'));
if (seedN > 0) seedTestAuthors(seedN);

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
ensureCommunityReactionsLoaded(); // warm aggregate reactions in background too

register('/', () => import('./views/home.js'));
register('/map', () => import('./views/map.js'));
register('/c/:id', () => import('./views/compilation.js'));
register('/upload', () => import('./views/upload.js'));
register('/profile', () => import('./views/profile.js'));
register('/migrate', () => import('./views/migrate.js'));
register('/users', () => import('./views/users.js'));
register('/validate', () => import('./views/validate.js'));
register('/author/:name', () => import('./views/author.js'));

start(document.getElementById('view'));

}

runBoot();
