// Minimal one-shot toast. A single floating message at the bottom of the screen
// that auto-dismisses; optionally clickable. No such helper existed before — the
// nearest precedent was the inline flash() in views/users.js (not reusable).

let current = null;

// Show a transient toast. `onClick` (if given) runs on tap and dismisses it.
// Returns a dismiss() function.
export function showToast(msg, { onClick = null, timeout = 6000 } = {}) {
  dismiss();

  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = msg;
  if (onClick) {
    el.classList.add('toast--clickable');
    el.addEventListener('click', () => { onClick(); dismiss(); });
  }
  document.body.appendChild(el);
  // Next frame → transition the entrance.
  requestAnimationFrame(() => el.classList.add('toast--in'));

  const timer = timeout ? setTimeout(dismiss, timeout) : null;
  current = { el, timer };
  return dismiss;
}

export function dismiss() {
  if (!current) return;
  const { el, timer } = current;
  current = null;
  if (timer) clearTimeout(timer);
  el.classList.remove('toast--in');
  el.addEventListener('transitionend', () => el.remove(), { once: true });
  // Fallback removal in case the element was never painted (no transition).
  setTimeout(() => el.remove(), 400);
}
