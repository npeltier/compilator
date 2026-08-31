// Admin-only sandbox for the notifications feature. Injects fake unread
// notifications into the in-memory feed so the nav badge, the load toast and the
// dropdown panel can be checked live — no second user, no emulator, no Firestore
// writes. Reachable at /notif-test (admin nav link, guarded by requireAdmin).

import { requireAdmin } from '../auth-guard.js';
import { injectSampleNotifications } from '../notifications.js';
import { notifMenu } from '../notifications-menu.js';
import { showToast } from '../toast.js';

export async function mount(el) {
  await requireAdmin(); // redirects non-admins to /

  el.innerHTML = `
    <div class="shell">
      <p class="eyebrow">Admin</p>
      <h1>Test notifications</h1>
      <p style="color:var(--ink-dim);max-width:60ch;">
        Injecte des notifications factices pour vérifier le badge sur l'avatar, le toast
        et le panneau déroulant. Purement local — rien n'est écrit dans Firestore, et un
        rechargement de la page efface tout.
      </p>
      <div class="chip-row" style="margin-top:16px;">
        <button class="btn" id="inject">Injecter 3 notifications</button>
        <button class="btn btn-ghost" id="open">Ouvrir le panneau</button>
        <button class="btn btn-ghost" id="toast">Rejouer le toast</button>
      </div>
      <div id="notifTestMsg" class="notice" hidden></div>
    </div>
  `;

  const msg = el.querySelector('#notifTestMsg');
  const flash = (text) => { msg.textContent = text; msg.hidden = false; };

  const ctrl = notifMenu();
  if (!ctrl) { flash('Menu de notifications non initialisé — recharge la page.'); return; }

  let lastCount = 0;

  el.querySelector('#inject').addEventListener('click', () => {
    lastCount = injectSampleNotifications(3);
    ctrl.refresh();
    const s = lastCount > 1 ? 's' : '';
    showToast(`Tu as ${lastCount} nouvelle${s} notification${s}`, { onClick: ctrl.openPanel });
    flash(`${lastCount} notifications injectées. Regarde le badge sur l'avatar, en haut à droite.`);
  });

  el.querySelector('#open').addEventListener('click', () => ctrl.openPanel());

  el.querySelector('#toast').addEventListener('click', () => {
    const n = lastCount || 3;
    const s = n > 1 ? 's' : '';
    showToast(`Tu as ${n} nouvelle${s} notification${s}`, { onClick: ctrl.openPanel });
  });
}
