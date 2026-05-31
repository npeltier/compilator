// Tiny History-API router. Routes are registered with patterns like '/c/:id'.
// Each route's loader returns a module exposing `mount(el, ctx)`; the router
// renders into `viewEl`. Same-origin link clicks are intercepted so navigation
// happens in-place — the surrounding shell (topbar + player) survives.

const routes = [];
let viewEl;
let currentCleanup;

export function register(pattern, loader) {
  const keys = [];
  const reSource = pattern.replace(/:[A-Za-z]+/g, (m) => {
    keys.push(m.slice(1));
    return '([^/]+)';
  });
  routes.push({ re: new RegExp(`^${reSource}$`), keys, loader });
}

export async function dispatch() {
  const path = location.pathname;
  for (const { re, keys, loader } of routes) {
    const m = path.match(re);
    if (!m) continue;
    const params = {};
    keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    const query = Object.fromEntries(new URLSearchParams(location.search));
    if (currentCleanup) { try { currentCleanup(); } catch (_) { /* ignore */ } }
    viewEl.innerHTML = '';
    window.scrollTo(0, 0);
    const mod = await loader();
    const result = await mod.mount(viewEl, { params, query });
    currentCleanup = typeof result === 'function' ? result : null;
    return;
  }
  viewEl.innerHTML = '<div class="shell"><h1>404</h1><p class="notice">Page introuvable.</p></div>';
}

export function navigate(path) {
  const full = path || '/';
  if (full === location.pathname + location.search) return;
  history.pushState(null, '', full);
  dispatch();
}

export function start(el) {
  viewEl = el;
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    const a = e.target.closest('a');
    if (!a) return;
    if (a.target && a.target !== '_self') return;
    if (a.hasAttribute('data-external')) return;
    if (a.getAttribute('href')?.startsWith('#')) return;
    if (a.origin !== location.origin) return;
    // Let real files (login.html, etc.) load normally.
    if (a.pathname.endsWith('.html')) return;
    e.preventDefault();
    navigate(a.pathname + a.search);
  });
  window.addEventListener('popstate', dispatch);
  dispatch();
}
