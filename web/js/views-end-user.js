/* End-user views: Home (app launcher), My Access, Request Access, My Tasks, Settings. */
import { api } from './api.js';
import { el, esc, fmtDate, ilgBadge, initials } from './ui.js';

const ROLES_ADMIN = ['ADMIN', 'SUPER_ADMIN'];

/* ---------- Login ---------- */
export function renderLogin() {
  const root = el(`
    <div class="auth-shell">
      <aside class="auth-hero">
        <div class="brand-mark">
          <span class="brand-logo" style="width:32px;height:32px;background:linear-gradient(135deg,#fff,#dbeafe);border-radius:8px;display:inline-flex;align-items:center;justify-content:center;color:#1e3a8a;font-weight:800">L</span>
          Lenskart IdP
        </div>
        <div>
          <h1>One identity. Every application.</h1>
          <p>Enterprise single sign-on, SAML 2.0 identity provider, and identity governance for Lenskart.</p>
          <ul class="auth-features">
            <li>SAML 2.0 SSO &amp; OIDC login</li>
            <li>TOTP MFA, session management, password self-service</li>
            <li>Identity lifecycle, access requests, certifications</li>
            <li>Audit trail and compliance reports</li>
          </ul>
        </div>
        <div class="auth-footer">© Lenskart Identity · idp.lenskart.com</div>
      </aside>
      <main class="auth-panel">
        <div class="auth-card">
          <h2>Sign in</h2>
          <p class="muted">Use your administrator account or corporate SSO.</p>
          <div id="login-error"></div>
          <form id="local-login-form">
            <div class="field"><label for="email">Email</label>
              <input id="email" name="email" type="email" required autocomplete="username" placeholder="you@lenskart.com" /></div>
            <div class="field"><label for="password">Password</label>
              <input id="password" name="password" type="password" required autocomplete="current-password" /></div>
            <button type="submit" class="btn btn-primary btn-block btn-lg">Sign in</button>
          </form>
          <div class="divider">or</div>
          <a href="/auth/google" class="btn btn-secondary btn-block">Continue with Google</a>
        </div>
      </main>
    </div>
  `);

  const errEl = root.querySelector('#login-error');
  const panel = root.querySelector('.auth-panel');

  function renderMfaStep(challengeId, email) {
    const card = el(`
      <div class="auth-card">
        <h2>Two-factor authentication</h2>
        <p class="muted">Enter the 6-digit code from your authenticator app for ${esc(email)}.</p>
        <div id="mfa-error"></div>
        <form id="mfa-form">
          <div class="field"><label>Verification code</label>
            <input name="code" required pattern="[0-9]{6,8}" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" />
            <p class="hint">A backup code (8 hex chars) also works.</p></div>
          <button type="submit" class="btn btn-primary btn-block btn-lg">Verify</button>
        </form>
      </div>
    `);
    panel.replaceChildren(card);
    const merr = card.querySelector('#mfa-error');
    card.querySelector('#mfa-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      merr.innerHTML = '';
      try {
        await api.localLoginMfa(challengeId, new FormData(e.target).get('code'));
        location.href = '/';
      } catch (err) {
        merr.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
      }
    });
  }

  root.querySelector('#local-login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.innerHTML = '';
    const fd = new FormData(e.target);
    const email = fd.get('email');
    try {
      const r = await api.localLogin(email, fd.get('password'));
      if (r && r.mfaRequired && r.challengeId) {
        renderMfaStep(r.challengeId, email);
        return;
      }
      location.href = '/';
    } catch (err) {
      errEl.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    }
  });

  api.adminStatus().then((s) => {
    if (!s.bootstrapEnabled) return;
    const card = el(`
      <div class="auth-card" style="margin-top:1.5rem">
        <h2 style="font-size:1.15rem">First-time setup</h2>
        <p class="muted">Create the first super administrator.</p>
        <div id="bs-error"></div>
        <form id="bs-form">
          <div class="field"><label>Full name</label><input name="fullName" required /></div>
          <div class="field"><label>Email</label><input name="email" type="email" required /></div>
          <div class="field"><label>Password (min 10)</label><input name="password" type="password" minlength="10" required /></div>
          <div class="field"><label>Bootstrap token</label><input name="token" type="password" required /><p class="hint">Value of LOCAL_BOOTSTRAP_TOKEN in .env</p></div>
          <button type="submit" class="btn btn-primary btn-block">Create super administrator</button>
        </form>
      </div>
    `);
    panel.appendChild(card);
    card.querySelector('#bs-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const bsErr = card.querySelector('#bs-error');
      bsErr.innerHTML = '';
      try {
        await api.bootstrapAdmin(Object.fromEntries(new FormData(e.target)));
        bsErr.innerHTML = `<div class="alert alert-success">Created. Sign in above.</div>`;
        e.target.reset();
      } catch (err) {
        bsErr.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
      }
    });
  }).catch(() => {});

  return root;
}

/* ---------- Home: app launcher (miniOrange-style) ---------- */
function appTile(app) {
  const fb = app.iconUrl || app.icon_url
    ? `<img class="app-icon" src="${esc(app.iconUrl || app.icon_url)}" alt="" />`
    : `<div class="app-icon app-icon-fallback">${esc((app.name || '?').charAt(0).toUpperCase())}</div>`;
  const launch = app.launchUrl || (app.slug ? `/saml/launch/${app.slug}` : '#');
  return `<a class="app-tile" href="${esc(launch)}" target="_blank" rel="noopener" title="${esc(app.name)}">
    <span class="saml-badge">S</span>${fb}<span class="app-name">${esc(app.name)}</span>
  </a>`;
}

export async function viewHome(me, content) {
  const isAdmin = ROLES_ADMIN.includes(me.employee?.role);

  let myApps = [];
  let catalogApps = [];
  let samlEnabled = false;
  try {
    const r = await api.apps();
    samlEnabled = !!r.samlEnabled;
    myApps = r.data || [];
  } catch { /* ignore */ }
  try {
    const r2 = await api.igaApps();
    catalogApps = (r2.data || []).filter((a) => a.active && a.sso_enabled);
  } catch { /* ignore */ }

  const wrap = el(`
    <div>
      <div class="welcome-banner">
        <div>
          <h1>Welcome, ${esc(me.employee?.full_name || me.session?.email || 'there')}</h1>
          <p>Your single sign-on launchpad. ${samlEnabled ? `${myApps.length} apps available` : 'SAML IdP is being configured by an administrator'}.</p>
        </div>
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
          <span class="badge badge-light">${esc(me.employee?.role || 'USER')}</span>
          <span class="badge badge-light">${esc(me.session?.iss || 'local')}</span>
        </div>
      </div>

      <div class="apps-section">
        <div class="section-title-row">
          <div>
            <h2>Sign-in to your favourite cloud apps</h2>
            <div class="meta">${myApps.length} application${myApps.length === 1 ? '' : 's'} entitled</div>
          </div>
        </div>
        ${myApps.length
          ? `<div class="app-grid">${myApps.map(appTile).join('')}</div>`
          : `<p class="subtitle" style="text-align:center;padding:2rem 0">${samlEnabled
              ? 'No applications entitled yet. Visit Request Access to ask for one.'
              : (isAdmin ? 'SAML IdP signing keys not configured — see <a href="#" data-go="auth">Authentication</a>.' : 'Contact your administrator to enable SSO.')
            }</p>`}
      </div>

      ${catalogApps.length ? `
      <div class="apps-section">
        <div class="section-title-row">
          <div>
            <h2>Browse the application catalog</h2>
            <div class="meta">All applications onboarded to Lenskart IdP</div>
          </div>
        </div>
        <div class="app-grid">${catalogApps.map((c) => appTile({ name: c.name, slug: c.slug, iconUrl: c.icon_url })).join('')}</div>
      </div>` : ''}
    </div>
  `);

  wrap.querySelectorAll('[data-go]').forEach((a) => {
    a.addEventListener('click', (e) => { e.preventDefault(); window.LILG_NAV(a.dataset.go); });
  });
  content.replaceChildren(wrap);
}

/* ---------- My Access ---------- */
export async function viewMyAccess(content) {
  const wrap = el(`
    <div>
      <div class="page-header">
        <div><h1>My Access</h1><p class="subtitle">Entitlements and roles currently assigned to you</p></div>
        <a href="#" data-go="request" class="btn btn-primary">Request access</a>
      </div>
      <div id="ma-table"><div class="loading-row"><span class="spinner"></span></div></div>
    </div>`);
  content.replaceChildren(wrap);
  wrap.querySelector('[data-go]').addEventListener('click', (e) => { e.preventDefault(); window.LILG_NAV('request'); });

  try {
    const r = await api.igaMyAccess();
    const rows = r.data || [];
    const html = rows.length
      ? `<div class="table-wrap"><table>
          <thead><tr><th>Application</th><th>Entitlement</th><th>Type</th><th>Source</th><th>Granted</th><th>Expires</th></tr></thead>
          <tbody>${rows.map((r) => `<tr>
            <td class="cell-strong">${esc(r.app_name || '—')}</td>
            <td>${esc(r.entitlement_name)}</td>
            <td><span class="badge badge-info">${esc(r.type)}</span></td>
            <td><span class="badge badge-neutral">${esc(r.source)}</span></td>
            <td class="muted">${fmtDate(r.granted_at)}</td>
            <td class="muted">${fmtDate(r.expires_at) || 'Never'}</td>
          </tr>`).join('')}</tbody></table></div>`
      : `<div class="card empty-state"><span class="empty-icon">◫</span>You have no managed entitlements yet</div>`;
    wrap.querySelector('#ma-table').innerHTML = html;
  } catch (err) {
    wrap.querySelector('#ma-table').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
}

/* ---------- Request Access (placeholder for now) ---------- */
export async function viewRequestAccess(content) {
  const wrap = el(`
    <div>
      <div class="page-header">
        <div><h1>Request Access</h1><p class="subtitle">Browse the catalog and request applications, roles, or entitlements</p></div>
      </div>
      <div class="card">
        <h2>Catalog browser</h2>
        <p class="subtitle" style="margin-top:0.5rem">
          End-user catalog with one-click request, justification, validity period and pre-flight SoD check ships in the next release.
          The <code>POST /api/iga/access-requests</code> endpoint is scaffolded and returns 501 until the approval-chain resolver lands.
        </p>
      </div>
    </div>`);
  content.replaceChildren(wrap);
}

/* ---------- My Tasks ---------- */
export async function viewMyTasks(content) {
  const wrap = el(`
    <div>
      <div class="page-header"><div>
        <h1>My Tasks</h1><p class="subtitle">Pending approvals and access reviews assigned to you</p>
      </div></div>
      <h3 class="section-title">Access request approvals</h3>
      <div id="t-approvals"><div class="loading-row"><span class="spinner"></span></div></div>
      <h3 class="section-title">Access review items</h3>
      <div id="t-reviews"><div class="loading-row"><span class="spinner"></span></div></div>
    </div>`);
  content.replaceChildren(wrap);

  try {
    const r = await api.igaMyTasks();
    const rows = r.data || [];
    wrap.querySelector('#t-approvals').innerHTML = rows.length
      ? `<div class="table-wrap"><table>
          <thead><tr><th>Request</th><th>Requester</th><th>For</th><th>Type</th><th>Submitted</th></tr></thead>
          <tbody>${rows.map((r) => `<tr>
            <td><code>${esc(String(r.id).slice(0, 8))}</code></td>
            <td>${esc(r.requester_name || r.requester_emp_id)}</td>
            <td>${esc(r.target_name || r.target_emp_id)}</td>
            <td><span class="badge badge-info">${esc(r.item_type)}</span></td>
            <td class="muted">${fmtDate(r.created_at)}</td>
          </tr>`).join('')}</tbody></table></div>`
      : `<div class="card empty-state"><span class="empty-icon">◐</span>No pending approvals</div>`;
  } catch (err) {
    wrap.querySelector('#t-approvals').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }

  try {
    const r = await api.igaMyReviews();
    const rows = r.data || [];
    wrap.querySelector('#t-reviews').innerHTML = rows.length
      ? `<div class="table-wrap"><table>
          <thead><tr><th>Campaign</th><th>Subject</th><th>Item</th><th>Due</th></tr></thead>
          <tbody>${rows.map((r) => `<tr>
            <td>${esc(r.campaign_name)}</td>
            <td>${esc(r.subject_name || r.emp_id)}</td>
            <td>${esc(r.entitlement_name || r.role_name || '—')}</td>
            <td class="muted">${fmtDate(r.end_date)}</td>
          </tr>`).join('')}</tbody></table></div>`
      : `<div class="card empty-state"><span class="empty-icon">✓</span>No active review items</div>`;
  } catch (err) {
    wrap.querySelector('#t-reviews').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
}

/* ---------- Settings (Profile / Security / Sessions / MFA) ---------- */
export async function viewSettings(me, content) {
  const isLocal = me.session?.iss === 'local';
  const wrap = el(`
    <div>
      <div class="page-header"><div><h1>Account</h1><p class="subtitle">Profile, security, sessions and capabilities</p></div></div>
      <div class="tabs">
        <button class="tab active" data-tab="profile">Profile</button>
        ${isLocal ? '<button class="tab" data-tab="security">Security</button>' : ''}
        <button class="tab" data-tab="sessions">Sessions</button>
        <button class="tab" data-tab="mfa">Two-factor</button>
      </div>
      <div id="settings-content"><div class="loading-row"><span class="spinner"></span></div></div>
    </div>`);
  content.replaceChildren(wrap);
  const target = wrap.querySelector('#settings-content');

  function profile() {
    target.innerHTML = `<div class="grid-3">
      <div class="card"><h2>Profile</h2><div class="kv-list" style="margin-top:1rem">
        <div class="kv"><div class="k">Full name</div><div class="v">${esc(me.employee?.full_name || '—')}</div></div>
        <div class="kv"><div class="k">Email</div><div class="v">${esc(me.session?.email || '—')}</div></div>
        <div class="kv"><div class="k">Employee ID</div><div class="v"><code>${esc(me.employee?.emp_id || '—')}</code></div></div>
        <div class="kv"><div class="k">Role</div><div class="v"><span class="badge badge-info">${esc(me.employee?.role || 'USER')}</span></div></div>
        <div class="kv"><div class="k">Department</div><div class="v">${esc(me.employee?.dept_id || '—')}</div></div>
        <div class="kv"><div class="k">ILG state</div><div class="v">${ilgBadge(me.employee?.ilg_state)}</div></div>
      </div></div>
      <div class="card"><h2>Sign-in method</h2><div class="kv-list" style="margin-top:1rem">
        <div class="kv"><div class="k">Issuer</div><div class="v"><span class="badge badge-info">${esc(me.session?.iss || '—')}</span></div></div>
        <div class="kv"><div class="k">Subject</div><div class="v"><code class="truncate" title="${esc(me.session?.sub || '')}">${esc(me.session?.sub || '—')}</code></div></div>
        <div class="kv"><div class="k">Session expires</div><div class="v">${fmtDate(me.session?.expiresAt)}</div></div>
      </div></div>
      <div class="card"><h2>Capabilities</h2><div class="kv-list" style="margin-top:1rem">
        ${Object.entries(me.capabilities || {}).map(([k, v]) => `<div class="kv">
          <div class="k">${esc(k)}</div>
          <div class="v">${typeof v === 'boolean' ? (v ? '<span class="badge badge-success">Yes</span>' : '<span class="badge badge-neutral">No</span>') : esc(v ?? '—')}</div>
        </div>`).join('')}
      </div></div>
    </div>`;
  }
  function security() {
    if (!isLocal) {
      target.innerHTML = `<div class="alert alert-info">Password change is only available for local accounts. You signed in via <code>${esc(me.session?.iss || '')}</code>.</div>`;
      return;
    }
    target.innerHTML = `<div class="card" style="max-width:520px">
      <h2>Change password</h2>
      <p class="subtitle" style="margin-bottom:1rem">Minimum 10 characters. Other sessions stay active until you sign them out.</p>
      <div id="cp-error"></div>
      <form id="cp-form">
        <div class="field"><label>Current password</label><input name="currentPassword" type="password" required autocomplete="current-password" /></div>
        <div class="field"><label>New password</label><input name="newPassword" type="password" minlength="10" required autocomplete="new-password" /></div>
        <div class="field"><label>Confirm new password</label><input name="confirm" type="password" minlength="10" required autocomplete="new-password" /></div>
        <button type="submit" class="btn btn-primary">Update password</button>
      </form>
    </div>`;
    target.querySelector('#cp-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = target.querySelector('#cp-error');
      errEl.innerHTML = '';
      const fd = new FormData(e.target);
      if (fd.get('newPassword') !== fd.get('confirm')) {
        errEl.innerHTML = `<div class="alert alert-error">New passwords do not match</div>`;
        return;
      }
      try {
        await api.changePassword(fd.get('currentPassword'), fd.get('newPassword'));
        errEl.innerHTML = `<div class="alert alert-success">Password updated.</div>`;
        e.target.reset();
      } catch (err) {
        errEl.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
      }
    });
  }
  async function sessions() {
    target.innerHTML = `<div class="loading-row"><span class="spinner"></span></div>`;
    try {
      const r = await api.listSessions();
      const rows = r.data || [];
      const body = rows.length ? rows.map((s) => `<tr>
        <td><code>${esc(s.session_id.slice(0,8))}…</code> ${s.isCurrent ? '<span class="badge badge-success">Current</span>' : ''}</td>
        <td><span class="badge badge-info">${esc(s.iss)}</span></td>
        <td class="muted">${fmtDate(s.last_active_at)}</td>
        <td class="muted">${fmtDate(s.expires_at)}</td>
        <td class="muted truncate" title="${esc(s.user_agent || '')}">${esc(s.ip || '—')}</td>
        <td class="actions"><button class="btn btn-sm btn-danger" data-revoke="${esc(s.session_id)}">${s.isCurrent ? 'Sign out' : 'Revoke'}</button></td>
      </tr>`).join('') : `<tr><td colspan="6" class="empty-state"><span class="empty-icon">◌</span>No active sessions</td></tr>`;
      target.innerHTML = `<div class="table-wrap"><div class="table-toolbar">
        <strong>Active sessions</strong><span class="muted">${rows.length} session${rows.length === 1 ? '' : 's'}</span></div>
        <table><thead><tr><th>Session</th><th>Issuer</th><th>Last active</th><th>Expires</th><th>IP</th><th></th></tr></thead>
        <tbody>${body}</tbody></table></div>`;
      target.querySelectorAll('[data-revoke]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.revoke;
          if (!confirm('Revoke this session?')) return;
          try {
            await api.revokeSession(id);
            if (id === me.session?.sessionId) { location.href = '/login'; return; }
            sessions();
          } catch (err) { alert(err.message); }
        });
      });
    } catch (err) {
      target.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    }
  }
  async function mfa() {
    target.innerHTML = `<div class="loading-row"><span class="spinner"></span></div>`;
    let s;
    try { s = await api.mfaStatus(); }
    catch (err) { target.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`; return; }
    if (s.enabled) {
      target.innerHTML = `<div class="card" style="max-width:560px">
        <h2>Two-factor authentication</h2>
        <p class="subtitle" style="margin-bottom:1rem"><span class="badge badge-success">Enabled</span> Last used ${fmtDate(s.lastUsedAt)} · ${s.remainingBackupCodes} backup codes left</p>
        <button class="btn btn-secondary" id="mfa-regen">Regenerate backup codes</button>
        <button class="btn btn-danger" id="mfa-disable" style="margin-left:0.5rem">Disable</button>
        <div id="mfa-action-result" style="margin-top:1rem"></div>
      </div>`;
      target.querySelector('#mfa-disable').addEventListener('click', async () => {
        if (!confirm('Disable two-factor authentication?')) return;
        await api.mfaDisable(); mfa();
      });
      target.querySelector('#mfa-regen').addEventListener('click', async () => {
        if (!confirm('Replace all backup codes? Old codes will stop working.')) return;
        try {
          const r = await api.mfaRegenCodes();
          target.querySelector('#mfa-action-result').innerHTML = `<div class="alert alert-warning"><div>
            <div style="font-weight:600;margin-bottom:0.5rem">Save these backup codes — shown only once</div>
            <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:0.4rem;font-family:var(--font-mono);font-size:0.9rem">
              ${r.backupCodes.map((c) => `<div>${esc(c)}</div>`).join('')}
            </div></div></div>`;
        } catch (err) { alert(err.message); }
      });
      return;
    }
    target.innerHTML = `<div class="card" style="max-width:560px">
      <h2>Two-factor authentication</h2>
      <p class="subtitle" style="margin-bottom:1rem"><span class="badge badge-warning">Disabled</span> Adds a 6-digit code on every sign-in.</p>
      <button class="btn btn-primary" id="mfa-start">Enable two-factor</button>
      <div id="mfa-enroll"></div>
    </div>`;
    target.querySelector('#mfa-start').addEventListener('click', async () => {
      const area = target.querySelector('#mfa-enroll');
      try {
        const r = await api.mfaEnroll();
        area.innerHTML = `<div style="margin-top:1.25rem;padding-top:1.25rem;border-top:1px solid var(--border)">
          <p class="subtitle" style="margin-bottom:0.75rem">Scan with Google Authenticator, Authy, 1Password.</p>
          <img src="${esc(r.qrDataUrl)}" alt="" style="background:white;padding:0.5rem;border-radius:8px" />
          <p class="subtitle" style="margin-top:0.75rem">Or enter this secret: <code>${esc(r.secret)}</code></p>
          <form id="mfa-confirm" style="margin-top:1rem">
            <div class="field"><label>6-digit code</label><input name="code" required pattern="[0-9]{6}" inputmode="numeric" autocomplete="one-time-code" /></div>
            <button class="btn btn-primary" type="submit">Verify and enable</button>
          </form>
          <div id="mfa-confirm-result"></div>
        </div>`;
        area.querySelector('#mfa-confirm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const out = area.querySelector('#mfa-confirm-result');
          out.innerHTML = '';
          try {
            const code = new FormData(e.target).get('code');
            const r2 = await api.mfaConfirm(code);
            out.innerHTML = `<div class="alert alert-success" style="margin-top:1rem">Two-factor enabled.</div>
              <div class="alert alert-warning" style="margin-top:0.5rem"><div>
                <div style="font-weight:600;margin-bottom:0.5rem">Save these backup codes — shown only once</div>
                <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:0.4rem;font-family:var(--font-mono);font-size:0.9rem">
                  ${r2.backupCodes.map((c) => `<div>${esc(c)}</div>`).join('')}
                </div></div></div>
              <button class="btn btn-secondary" id="mfa-done" style="margin-top:0.75rem">Done</button>`;
            out.querySelector('#mfa-done').addEventListener('click', () => mfa());
          } catch (err) {
            out.innerHTML = `<div class="alert alert-error" style="margin-top:1rem">${esc(err.message)}</div>`;
          }
        });
      } catch (err) {
        area.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
      }
    });
  }
  function showTab(name) {
    wrap.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    if (name === 'profile') profile();
    else if (name === 'security') security();
    else if (name === 'sessions') sessions();
    else if (name === 'mfa') mfa();
  }
  wrap.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => showTab(tab.dataset.tab)));
  profile();
}
