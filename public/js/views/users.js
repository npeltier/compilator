// Admin-only users management view at /users.
//
// Lists every allowlist entry alongside its /users doc (if any), with a form
// to add a new user (email + optional displayName) and a button to remove one.
// All writes go through Cloud Functions (rules block direct client writes to
// /allowlist, and /users updates are restricted to self).

import { auth } from '../firebase-init.js';
import { sendPasswordResetEmail } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js';
import { requireAdmin } from '../auth-guard.js';
import {
  allAccessRequests,
  allAuthorOptions,
  displayNameFor,
  loadAccessRequests,
  loadAllowlist,
  loadCatalog,
  removeAccessRequestLocal,
  updateUserLocal,
} from '../catalog.js';
import {
  approveAccessRequest,
  denyAccessRequest,
  removeUser,
  upsertUser,
} from '../upload-pipeline.js';
import { avatarHTML, paintAvatars } from '../avatar.js';

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export async function mount(el) {
  const me = await requireAdmin();
  const myEmail = me.email.toLowerCase();

  el.innerHTML = `
    <div class="shell-narrow">
      <p class="eyebrow">Administration</p>
      <h1>Utilisateurs.</h1>

      <div id="error" class="error" hidden></div>
      <div id="ok" class="notice" hidden></div>

      <section class="section" id="requestsSection" hidden>
        <h3>Demandes d'accès <span id="requestCount" class="eyebrow" style="float:right"></span></h3>
        <p style="color:var(--ink-faint);font-size:12px;margin:-4px 0 16px;">
          Ces personnes ont essayé de se connecter mais ne sont pas encore autorisées.
          <strong>Approuver</strong> les ajoute à la liste d'autorisation ; <strong>Refuser</strong>
          supprime la demande et leur compte.
        </p>
        <ul id="requestList" class="user-admin-list"></ul>
      </section>

      <section class="section">
        <h3>Ajouter quelqu'un</h3>
        <p style="color:var(--ink-faint);font-size:12px;margin:-4px 0 16px;">
          L'adresse e-mail est ajoutée à la liste d'autorisation. Le nom d'affichage est
          facultatif — sans lui, le pseudo de la personne sera la partie locale de son e-mail
          tant qu'elle n'a pas modifié son profil.
        </p>
        <form id="addForm" class="field-row">
          <div>
            <label for="addEmail">Adresse e-mail</label>
            <input id="addEmail" type="email" required placeholder="prenom.nom@gmail.com">
          </div>
          <div>
            <label for="addName">Nom d'affichage (facultatif)</label>
            <input id="addName" placeholder="Prénom N.">
          </div>
          <div style="display:flex;align-items:end;">
            <button type="submit" class="btn-accent" style="width:100%;padding:12px;">Ajouter</button>
          </div>
        </form>
      </section>

      <section class="section">
        <h3>Membres <span id="userCount" class="eyebrow" style="float:right"></span></h3>
        <ul id="userList" class="user-admin-list"></ul>
      </section>
    </div>
  `;

  const errEl = el.querySelector('#error');
  const okEl = el.querySelector('#ok');
  function flash(node, msg) {
    errEl.hidden = true; okEl.hidden = true;
    node.textContent = msg;
    node.hidden = false;
  }

  function renderRequests() {
    const section = el.querySelector('#requestsSection');
    const list = el.querySelector('#requestList');
    const countEl = el.querySelector('#requestCount');
    const requests = allAccessRequests();
    section.hidden = requests.length === 0;
    countEl.textContent = `${requests.length} en attente`;
    list.innerHTML = '';
    requests.forEach((r) => {
      const li = document.createElement('li');
      li.className = 'user-admin-row';
      const name = (r.displayName || '').trim();
      li.innerHTML = `
        ${avatarHTML(r.email, { size: 'sm' })}
        <div class="ua-meta">
          <div class="ua-name">${name ? escape(name) : escape(r.email.split('@')[0])} <span class="ua-tag">demande</span></div>
          <div class="ua-email">${escape(r.email)}</div>
        </div>
        <div class="ua-actions">
          <button class="btn-accent ua-approve" type="button">Approuver</button>
          <button class="btn-ghost danger ua-deny" type="button">Refuser</button>
        </div>
      `;
      li.querySelector('.ua-approve').addEventListener('click', () => approve(r, li));
      li.querySelector('.ua-deny').addEventListener('click', () => deny(r, li));
      list.appendChild(li);
    });
    paintAvatars(list);
  }

  async function approve(r, li) {
    const btns = li.querySelectorAll('button');
    btns.forEach((b) => (b.disabled = true));
    try {
      await approveAccessRequest({ email: r.email, displayName: r.displayName || '' });
      removeAccessRequestLocal(r.email);
      // Refresh the allowlist so the newly approved member shows in "Membres".
      await loadAllowlist();
      flash(okEl, `${r.email} approuvé et ajouté aux membres.`);
      renderRequests();
      renderList();
    } catch (err) {
      btns.forEach((b) => (b.disabled = false));
      flash(errEl, `Échec : ${err.message || err}`);
    }
  }

  async function deny(r, li) {
    if (!confirm(`Refuser ${r.email} ?\n(La demande et son compte sont supprimés.)`)) return;
    const btns = li.querySelectorAll('button');
    btns.forEach((b) => (b.disabled = true));
    try {
      await denyAccessRequest(r.email);
      removeAccessRequestLocal(r.email);
      flash(okEl, `${r.email} refusé.`);
      renderRequests();
    } catch (err) {
      btns.forEach((b) => (b.disabled = false));
      flash(errEl, `Échec : ${err.message || err}`);
    }
  }

  function renderList() {
    const list = el.querySelector('#userList');
    const countEl = el.querySelector('#userCount');
    const users = allAuthorOptions();
    countEl.textContent = `${users.length} ${users.length > 1 ? 'membres' : 'membre'}`;
    list.innerHTML = '';
    users.forEach((u) => {
      const li = document.createElement('li');
      li.className = 'user-admin-row';
      li.innerHTML = `
        ${avatarHTML(u.email, { size: 'sm' })}
        <div class="ua-meta">
          <div class="ua-name">${escape(u.displayName)}${u.linked ? '' : ' <span class="ua-tag">en attente</span>'}</div>
          <div class="ua-email">${escape(u.email)}</div>
        </div>
        <div class="ua-actions">
          <button class="btn-ghost ua-rename" type="button">Renommer</button>
          ${u.email === myEmail ? '' : '<button class="btn-ghost danger ua-remove" type="button">Retirer</button>'}
        </div>
      `;
      li.querySelector('.ua-rename').addEventListener('click', () => promptRename(u));
      li.querySelector('.ua-remove')?.addEventListener('click', () => confirmRemove(u));
      list.appendChild(li);
    });
    paintAvatars(list);
  }

  async function promptRename(u) {
    const next = prompt(`Nouveau nom d'affichage pour ${u.email} :`, u.displayName === u.email ? '' : u.displayName);
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed) return;
    try {
      await upsertUser({ email: u.email, displayName: trimmed });
      updateUserLocal(u.email, { displayName: trimmed });
      flash(okEl, `${u.email} → ${trimmed}`);
      renderList();
    } catch (err) {
      flash(errEl, `Échec : ${err.message || err}`);
    }
  }

  async function confirmRemove(u) {
    if (!confirm(`Retirer ${u.email} de la liste d'autorisation ?\n(Son compte Firebase Auth n'est pas supprimé.)`)) return;
    try {
      await removeUser(u.email);
      flash(okEl, `${u.email} retiré.`);
      // Rebuild caches so the list refresh reflects the deletion.
      await loadAllowlist();
      renderList();
    } catch (err) {
      flash(errEl, `Échec : ${err.message || err}`);
    }
  }

  el.querySelector('#addForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = el.querySelector('#addEmail').value.trim().toLowerCase();
    const displayName = el.querySelector('#addName').value.trim();
    if (!email) return;
    const btn = el.querySelector('#addForm button[type=submit]');
    btn.disabled = true; btn.textContent = 'Envoi…';
    try {
      const result = await upsertUser({ email, displayName });
      if (displayName) updateUserLocal(email, { displayName });
      await loadAllowlist();
      el.querySelector('#addEmail').value = '';
      el.querySelector('#addName').value = '';
      let msg = `${email} ajouté${displayName ? ` en tant que ${displayName}` : ''}`;
      if (result.authCreated) {
        try {
          await sendPasswordResetEmail(auth, email);
          msg += ` — e-mail d'invitation envoyé pour qu'il définisse son mot de passe.`;
        } catch (mailErr) {
          msg += ` — compte créé, mais l'envoi de l'e-mail d'invitation a échoué (${mailErr.message || mailErr}). Demande-lui de cliquer sur « Mot de passe oublié » à la connexion.`;
        }
      }
      flash(okEl, msg);
      renderList();
    } catch (err) {
      flash(errEl, `Échec : ${err.message || err}`);
    } finally {
      btn.disabled = false; btn.textContent = 'Ajouter';
    }
  });

  // Make sure both /users and /allowlist are loaded before listing (catalog is
  // already loaded by the shell, but allowlist is only loaded for admins on boot
  // — guard against the unlikely case where the boot fetch failed silently).
  if (allAuthorOptions().length === 0) {
    await Promise.all([loadCatalog(), loadAllowlist().catch(() => {})]);
  }
  renderList();

  // Access requests are admin-only and not part of the boot payload — fetch
  // them here, then render (or leave the section hidden if there are none).
  await loadAccessRequests().catch(() => {});
  renderRequests();
}
