/* ============================================================
   Lenskart IdP Console — SPA
   ============================================================ */

const api = {
  async fetch(path, options = {}) {
    const res = await fetch(path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const ct = res.headers.get('content-type') || '';
    const body = ct.includes('json') ? await res.json() : await res.text();
    if (!res.ok) {
      const err = new Error((body && body.error) || res.statusText);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  },
  me:               () => api.fetch('/api/me'),
  apps:             () => api.fetch('/api/apps'),
  dashboard:        () => api.fetch('/api/admin/dashboard'),
  listUsers:        (q = '', state = '') => api.fetch(`/api/admin/users?q=${encodeURIComponent(q)}&state=${encodeURIComponent(state)}&limit=200`),
  listLocalAdmins:  () => api.fetch('/api/admin/local-users'),
  createLocalAdmin: (data) => api.fetch('/api/admin/local-users', { method: 'POST', body: JSON.stringify(data) }),
  bootstrapAdmin:   (data) => api.fetch('/api/admin/local-users/bootstrap', { method: 'POST', body: JSON.stringify(data) }),
  adminStatus:      () => api.fetch('/api/admin/local-users/status'),
  deactivateAdmin:  (id) => api.fetch(`/api/admin/local-users/${id}`, { method: 'DELETE' }),
  idpStatus:        () => api.fetch('/api/admin/saml-apps/status'),
  listSamlApps:     () => api.fetch('/api/admin/saml-apps'),
  createSamlApp:    (data) => api.fetch('/api/admin/saml-apps', { method: 'POST', body: JSON.stringify(data) }),
  deactivateSamlApp:(id) => api.fetch(`/api/admin/saml-apps/${id}`, { method: 'DELETE' }),
  samlAudit:        () => api.fetch('/api/admin/audit/saml'),
  systemAudit:      () => api.fetch('/api/admin/audit/system'),
  localLogin:       (email, password) => api.fetch('/auth/local/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  localLoginMfa:    (challengeId, code) => api.fetch('/auth/local/login/mfa-verify', { method: 'POST', body: JSON.stringify({ challengeId, code }) }),
  logout:           () => api.fetch('/auth/logout', { method: 'POST' }),
  changePassword:   (currentPassword, newPassword) => api.fetch('/api/me/password', { method: 'PUT', body: JSON.stringify({ currentPassword, newPassword }) }),
  listSessions:     () => api.fetch('/api/me/sessions'),
  revokeSession:    (id) => api.fetch(`/api/me/sessions/${id}`, { method: 'DELETE' }),
  mfaStatus:        () => api.fetch('/api/me/mfa'),
  mfaEnroll:        () => api.fetch('/api/me/mfa/enroll', { method: 'POST' }),
  mfaConfirm:       (code) => api.fetch('/api/me/mfa/confirm', { method: 'POST', body: JSON.stringify({ code }) }),
  mfaDisable:       () => api.fetch('/api/me/mfa/disable', { method: 'POST' }),
  mfaRegenCodes:    () => api.fetch('/api/me/mfa/regenerate-codes', { method: 'POST' }),
};

const ROLES_ADMIN = ['ADMIN', 'SUPER_ADMIN'];

const ICONS = {
  dashboard: '◉',
  apps:      '▦',
  users:     '◍',
  saml:      '⛨',
  auth:      '⚿',
  audit:     '⌖',
  settings:  '⚙',
  logout:    '↪',
  search:    '🔍',
};

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return esc(s);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function initials(name = '') {
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '?';
}

function ilgBadge(state) {
  const s = (state || '').toUpperCase();
  if (s === 'ACTIVE' || s === 'REACTIVATED') return `<span class="badge badge-success">${esc(s)}</span>`;
  if (s.startsWith('SUSPENDED') || s === 'PENDING_MGR' || s === 'ESCALATED_HRBP') return `<span class="badge badge-warning">${esc(s)}</span>`;
  if (s === 'DEPARTED' || s === 'DEPROVISIONED') return `<span class="badge badge-neutral">${esc(s)}</span>`;
  return `<span class="badge badge-neutral">${esc(s || '—')}</span>`;
}

const state = {
  me: null,
  view: 'dashboard',
  query: '',
};

/* ---------- Login ---------- */
function renderLogin() {
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
            <li>SAML 2.0 / OIDC single sign-on</li>
            <li>Local, Google &amp; Zoho authentication</li>
            <li>Centralized application catalog</li>
            <li>Audit trail &amp; access governance</li>
          </ul>
        </div>
        <div class="auth-footer">© Lenskart Identity Lifecycle &amp; Governance · idp.lenskart.com</div>
      </aside>
      <main class="auth-panel">
        <div class="auth-card">
          <h2>Sign in</h2>
          <p class="muted">Use your administrator account or corporate SSO.</p>
          <div id="login-error"></div>
          <form id="local-login-form">
            <div class="field">
              <label for="email">Email</label>
              <input id="email" name="email" type="email" required autocomplete="username" placeholder="you@lenskart.com" />
            </div>
            <div class="field">
              <label for="password">Password</label>
              <input id="password" name="password" type="password" required autocomplete="current-password" />
            </div>
            <button type="submit" class="btn btn-primary btn-block btn-lg">Sign in</button>
          </form>
          <div class="divider">or</div>
          <a href="/auth/google" class="btn btn-secondary btn-block">Continue with Google</a>
          <a href="/auth/zoho"   class="btn btn-secondary btn-block" style="margin-top:0.5rem">Continue with Zoho</a>
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
          <div class="field">
            <label>Verification code</label>
            <input name="code" required pattern="[0-9]{6,8}" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" />
            <p class="hint">A backup code (8 hex chars) also works.</p>
          </div>
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

  // First-time bootstrap card (only when no admins exist)
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
    root.querySelector('.auth-panel').appendChild(card);
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

/* ---------- Shell ---------- */
function buildShell(activeView) {
  const me = state.me;
  const isAdmin = me && ROLES_ADMIN.includes(me.employee?.role);
  const isSuper = me && me.employee?.role === 'SUPER_ADMIN';

  const navItem = (key, icon, label, requiresAdmin = false, requiresSuper = false) => {
    if (requiresAdmin && !isAdmin) return '';
    if (requiresSuper && !isSuper) return '';
    return `<button class="nav-item ${activeView === key ? 'active' : ''}" data-view="${key}">
      <span class="icon">${icon}</span>${label}
    </button>`;
  };

  const root = el(`
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <span class="brand-logo">L</span>
          <span>Lenskart IdP</span>
        </div>
        <nav>
          <div class="nav-section">Workspace</div>
          ${navItem('dashboard', ICONS.dashboard, 'Dashboard', true)}
          ${navItem('apps',      ICONS.apps,      'My Applications')}
          ${isAdmin ? `<div class="nav-section">Administration</div>` : ''}
          ${navItem('saml-apps', ICONS.saml,      'SAML Applications', true)}
          ${navItem('users',     ICONS.users,     'Users', true)}
          ${navItem('admins',    ICONS.users,     'Administrators', false, true)}
          ${navItem('auth',      ICONS.auth,      'Authentication', true)}
          ${navItem('audit',     ICONS.audit,     'Audit Logs', true)}
          ${navItem('settings',  ICONS.settings,  'Settings')}
        </nav>
        <div class="sidebar-footer">v1.0 · ${esc(me?.session?.iss || 'local')}</div>
      </aside>
      <div class="main">
        <header class="topbar">
          <div class="page-title" id="page-title">Loading…</div>
          <div class="topbar-actions">
            <div class="profile-menu" id="profile-menu">
              <span class="avatar">${esc(initials(me?.employee?.full_name || me?.session?.email))}</span>
              <div>
                <div class="profile-name">${esc(me?.employee?.full_name || me?.session?.email || 'User')}</div>
                <div class="profile-role">${esc(me?.employee?.role || 'USER')}</div>
              </div>
              <div class="profile-dropdown" id="profile-dropdown">
                <a href="#" data-view-link="settings">Account settings</a>
                ${isAdmin ? `<a href="#" data-view-link="audit">Audit logs</a>` : ''}
                ${me?.capabilities?.metadataUrl ? `<a href="${esc(me.capabilities.metadataUrl)}" target="_blank">SAML metadata</a>` : ''}
                <div class="sep"></div>
                <button class="danger" id="logout-btn">Sign out</button>
              </div>
            </div>
          </div>
        </header>
        <main class="content" id="content"><div class="loading-row"><span class="spinner"></span></div></main>
      </div>
    </div>
  `);

  // Sidebar nav clicks
  root.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => navigate(btn.dataset.view));
  });
  // Profile dropdown
  const pm = root.querySelector('#profile-menu');
  const dd = root.querySelector('#profile-dropdown');
  pm.addEventListener('click', (e) => {
    if (e.target.closest('.profile-dropdown')) return;
    dd.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (!pm.contains(e.target)) dd.classList.remove('open');
  });
  root.querySelectorAll('[data-view-link]').forEach((a) => {
    a.addEventListener('click', (e) => { e.preventDefault(); navigate(a.dataset.viewLink); });
  });
  root.querySelector('#logout-btn').addEventListener('click', async () => {
    try { await api.logout(); } catch {}
    location.href = '/login';
  });

  return root;
}

function setPageTitle(title) {
  const t = document.querySelector('#page-title');
  if (t) t.textContent = title;
}

function setContent(node) {
  const c = document.querySelector('#content');
  if (!c) return;
  c.replaceChildren(node);
}

/* ---------- Views ---------- */

async function viewDashboard() {
  setPageTitle('Dashboard');
  const wrap = el(`<div></div>`);
  setContent(el(`<div class="loading-row"><span class="spinner"></span></div>`));
  let d;
  try { d = await api.dashboard(); }
  catch (err) {
    setContent(el(`<div class="alert alert-error">${esc(err.message)}</div>`));
    return;
  }

  const c = d.counts;
  const sys = d.system;

  const stats = `
    <section class="stat-grid">
      <div class="stat-card">
        <div class="stat-icon primary">◍</div>
        <div class="stat-label">Total users</div>
        <div class="stat-value">${c.employees}</div>
        <div class="stat-sub">${c.activeEmployees} active</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon accent">⛨</div>
        <div class="stat-label">SAML applications</div>
        <div class="stat-value">${c.activeSamlApps}</div>
        <div class="stat-sub">${c.samlApps} total registered</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon success">●</div>
        <div class="stat-label">Active sessions</div>
        <div class="stat-value">${c.activeSessions}</div>
        <div class="stat-sub">across all users</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon info">⌖</div>
        <div class="stat-label">SSO logins (24h)</div>
        <div class="stat-value">${c.assertions24h}</div>
        <div class="stat-sub">${c.assertions7d} in last 7 days</div>
      </div>
    </section>
  `;

  const sysRows = [
    ['SAML IdP',          sys.samlEnabled ? '<span class="badge badge-success">Enabled</span>' : '<span class="badge badge-warning">Not configured</span>'],
    ['Public base URL',   sys.publicBaseUrl ? esc(sys.publicBaseUrl) : '—'],
    ['SAML metadata',     sys.metadataUrl ? `<a href="${esc(sys.metadataUrl)}" target="_blank">${esc(sys.metadataUrl)}</a>` : '—'],
    ['Google OIDC',       sys.googleConfigured ? '<span class="badge badge-success">Configured</span>' : '<span class="badge badge-neutral">Not configured</span>'],
    ['Zoho OIDC',         sys.zohoConfigured ? '<span class="badge badge-success">Configured</span>' : '<span class="badge badge-neutral">Not configured</span>'],
    ['Local administrators', `${c.localAdmins}`],
  ];

  const recent = (d.recentAssertions && d.recentAssertions.length)
    ? d.recentAssertions.map((r) => `
        <tr>
          <td>${fmtDate(r.ts)}</td>
          <td class="cell-strong">${esc(r.sp_name)}</td>
          <td>${esc(r.emp_id)}</td>
          <td><span class="badge badge-info">${esc(r.binding)}</span></td>
        </tr>`).join('')
    : `<tr><td colspan="4" class="empty-state">No SSO assertions yet</td></tr>`;

  const ilg = (d.ilgStates || []).map((s) => `
    <div class="kv">
      <div class="k">${esc(s.ilg_state)}</div>
      <div class="v">${s.n}</div>
    </div>`).join('') || '<div class="empty-state" style="padding:1rem">No data</div>';

  wrap.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Dashboard</h1>
        <p class="subtitle">Overview of your identity &amp; access management deployment</p>
      </div>
    </div>
    ${stats}
    <div class="grid-3">
      <div class="card" style="grid-column: span 2; min-width:0">
        <h2>Recent SSO activity</h2>
        <p class="subtitle" style="margin-bottom:1rem">Latest SAML assertions issued by the IdP</p>
        <table>
          <thead><tr><th>Time</th><th>Application</th><th>User</th><th>Binding</th></tr></thead>
          <tbody>${recent}</tbody>
        </table>
      </div>
      <div class="card">
        <h2>System status</h2>
        <p class="subtitle" style="margin-bottom:1rem">Identity provider configuration</p>
        <div class="kv-list">
          ${sysRows.map(([k, v]) => `<div class="kv"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')}
        </div>
      </div>
      <div class="card">
        <h2>User lifecycle states</h2>
        <p class="subtitle" style="margin-bottom:1rem">Distribution of employees by ILG state</p>
        <div class="kv-list">${ilg}</div>
      </div>
    </div>
  `;

  setContent(wrap);
}

async function viewApps() {
  setPageTitle('My Applications');
  const wrap = el(`<div></div>`);
  setContent(el(`<div class="loading-row"><span class="spinner"></span></div>`));

  let r;
  try { r = await api.apps(); }
  catch (err) {
    setContent(el(`<div class="alert alert-error">${esc(err.message)}</div>`));
    return;
  }

  const isAdmin = ROLES_ADMIN.includes(state.me.employee?.role);
  const apps = r.data || [];

  let body;
  if (!r.samlEnabled) {
    body = `
      <div class="card">
        <h2>SAML IdP not configured</h2>
        <p class="subtitle">Single sign-on requires a SAML signing key/cert. ${isAdmin ? 'Open <a href="#" data-go="auth">Authentication</a> for setup steps.' : 'Contact your administrator.'}</p>
      </div>`;
  } else if (!apps.length) {
    body = `
      <div class="card">
        <h2>No applications yet</h2>
        <p class="subtitle">${isAdmin ? 'Register applications in <a href="#" data-go="saml-apps">SAML Applications</a>.' : 'Contact your administrator to onboard applications.'}</p>
      </div>`;
  } else {
    body = `<div class="app-grid">
      ${apps.map((a) => {
        const fb = a.iconUrl
          ? `<img class="app-icon" src="${esc(a.iconUrl)}" alt="" />`
          : `<div class="app-icon app-icon-fallback">${esc((a.name||'?').charAt(0).toUpperCase())}</div>`;
        return `<a class="app-tile" href="${esc(a.launchUrl)}" target="_blank" rel="noopener">${fb}<span class="app-name">${esc(a.name)}</span></a>`;
      }).join('')}
    </div>`;
  }

  wrap.innerHTML = `
    <div class="page-header">
      <div>
        <h1>My Applications</h1>
        <p class="subtitle">Single sign-on launcher for entitled enterprise apps</p>
      </div>
    </div>
    ${body}
  `;
  wrap.querySelectorAll('[data-go]').forEach((a) => {
    a.addEventListener('click', (e) => { e.preventDefault(); navigate(a.dataset.go); });
  });
  setContent(wrap);
}

async function viewSamlApps() {
  setPageTitle('SAML Applications');
  const wrap = el(`<div></div>`);
  setContent(el(`<div class="loading-row"><span class="spinner"></span></div>`));

  let resp, status;
  try {
    [resp, status] = await Promise.all([api.listSamlApps(), api.idpStatus().catch(() => ({}))]);
  } catch (err) {
    setContent(el(`<div class="alert alert-error">${esc(err.message)}</div>`));
    return;
  }

  const apps = resp.data || [];
  const isSuper = state.me.employee?.role === 'SUPER_ADMIN';

  const tableBody = apps.length
    ? apps.map((sp) => `
        <tr>
          <td class="cell-strong">${esc(sp.name)}</td>
          <td><code>${esc(sp.slug)}</code></td>
          <td class="truncate muted" title="${esc(sp.entity_id)}">${esc(sp.entity_id)}</td>
          <td class="truncate muted" title="${esc(sp.acs_url)}">${esc(sp.acs_url)}</td>
          <td>${sp.active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">Disabled</span>'}</td>
          <td class="actions">${isSuper && sp.active ? `<button class="btn btn-sm btn-danger" data-sp-id="${esc(sp.id)}">Deactivate</button>` : ''}</td>
        </tr>`).join('')
    : `<tr><td colspan="6" class="empty-state"><div class="empty-icon">⛨</div>No SAML applications registered</td></tr>`;

  wrap.innerHTML = `
    <div class="page-header">
      <div>
        <h1>SAML Applications</h1>
        <p class="subtitle">Service Providers registered with this Identity Provider</p>
      </div>
    </div>

    ${status.metadataUrl ? `
      <div class="alert alert-info" style="margin-bottom:1.5rem">
        <div>
          <div style="font-weight:500;margin-bottom:0.2rem">IdP metadata for SP onboarding</div>
          <a href="${esc(status.metadataUrl)}" target="_blank">${esc(status.metadataUrl)}</a>
        </div>
      </div>` : ''}

    ${isSuper ? `
    <details class="card" style="margin-bottom:1rem" open>
      <summary style="cursor:pointer;font-weight:600">Register new SAML application</summary>
      <p class="subtitle" style="margin:0.5rem 0 1rem">Add a Service Provider so users can launch it via SSO.</p>
      <div id="sp-error"></div>
      <form id="sp-form">
        <div class="grid-2">
          <div class="field"><label>Application name</label><input name="name" required placeholder="e.g. Darwinbox HRMS" /></div>
          <div class="field"><label>Slug (URL-safe)</label><input name="slug" required pattern="[a-z0-9-]+" placeholder="e.g. darwinbox" /></div>
          <div class="field"><label>SP Entity ID</label><input name="entityId" required placeholder="https://app.example.com/saml/metadata" /></div>
          <div class="field"><label>ACS URL (Assertion Consumer)</label><input name="acsUrl" type="url" required placeholder="https://app.example.com/saml/acs" /></div>
          <div class="field"><label>SLO URL (optional)</label><input name="sloUrl" type="url" placeholder="https://app.example.com/saml/slo" /></div>
          <div class="field"><label>Icon URL (optional)</label><input name="iconUrl" type="url" placeholder="https://..." /></div>
        </div>
        <button type="submit" class="btn btn-primary">Register application</button>
      </form>
    </details>` : ''}

    <div class="table-wrap">
      <div class="table-toolbar">
        <strong>Registered applications</strong>
        <span class="muted">${apps.length} total</span>
      </div>
      <table>
        <thead><tr><th>Name</th><th>Slug</th><th>Entity ID</th><th>ACS URL</th><th>Status</th><th></th></tr></thead>
        <tbody>${tableBody}</tbody>
      </table>
    </div>
  `;

  if (isSuper) {
    wrap.querySelector('#sp-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = wrap.querySelector('#sp-error');
      errEl.innerHTML = '';
      const body = Object.fromEntries(new FormData(e.target));
      if (!body.sloUrl) delete body.sloUrl;
      if (!body.iconUrl) delete body.iconUrl;
      try {
        await api.createSamlApp(body);
        errEl.innerHTML = `<div class="alert alert-success">Application registered.</div>`;
        e.target.reset();
        setTimeout(() => viewSamlApps(), 600);
      } catch (err) {
        errEl.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
      }
    });
  }

  wrap.querySelectorAll('[data-sp-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Deactivate this application?')) return;
      try { await api.deactivateSamlApp(btn.dataset.spId); viewSamlApps(); }
      catch (err) { alert(err.message); }
    });
  });

  setContent(wrap);
}

async function viewUsers() {
  setPageTitle('Users');
  const wrap = el(`<div></div>`);
  setContent(el(`<div class="loading-row"><span class="spinner"></span></div>`));

  async function load(q = '', stateFilter = '') {
    let r;
    try { r = await api.listUsers(q, stateFilter); }
    catch (err) {
      wrap.querySelector('#users-table').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
      return;
    }
    const rows = r.data || [];
    const html = rows.length ? rows.map((u) => `
      <tr>
        <td>
          <div style="display:flex;align-items:center;gap:0.6rem">
            <span class="avatar" style="width:30px;height:30px;font-size:0.7rem">${esc(initials(u.full_name))}</span>
            <div>
              <div class="cell-strong">${esc(u.full_name)}</div>
              <div class="muted" style="font-size:0.75rem">${esc(u.emp_id)}</div>
            </div>
          </div>
        </td>
        <td>${esc(u.email_corp)}</td>
        <td>${esc(u.dept_id || '—')}</td>
        <td>${esc(u.employment_type || '—')}</td>
        <td>${ilgBadge(u.ilg_state)}</td>
        <td>${u.admin_role ? `<span class="badge badge-info">${esc(u.admin_role)}</span>` : '<span class="muted">—</span>'}</td>
        <td class="muted">${fmtDate(u.last_login_at)}</td>
      </tr>
    `).join('') : `<tr><td colspan="7" class="empty-state"><div class="empty-icon">◍</div>No users found</td></tr>`;
    wrap.querySelector('#users-table tbody').innerHTML = html;
    wrap.querySelector('#users-count').textContent = `${r.total} total`;
  }

  wrap.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Users</h1>
        <p class="subtitle">Employees synced from HRMS, plus local IdP administrators</p>
      </div>
    </div>
    <div class="table-wrap" id="users-table">
      <div class="table-toolbar">
        <div class="search-input">
          <input id="user-search" type="search" placeholder="Search by name, email, employee ID…" />
        </div>
        <div style="display:flex;gap:0.5rem;align-items:center">
          <select id="state-filter" class="btn btn-secondary" style="padding:0.45rem 0.7rem">
            <option value="">All states</option>
            <option value="ACTIVE">Active</option>
            <option value="REACTIVATED">Reactivated</option>
            <option value="SUSPENDED_AUTO">Suspended (auto)</option>
            <option value="PENDING_MGR">Pending manager</option>
            <option value="ESCALATED_HRBP">Escalated HRBP</option>
            <option value="DEPARTED">Departed</option>
            <option value="DEPROVISIONED">Deprovisioned</option>
          </select>
          <span id="users-count" class="muted"></span>
        </div>
      </div>
      <table>
        <thead><tr>
          <th>Name</th><th>Email</th><th>Department</th><th>Type</th><th>State</th><th>Admin role</th><th>Last login</th>
        </tr></thead>
        <tbody><tr><td colspan="7" class="loading-row"><span class="spinner"></span></td></tr></tbody>
      </table>
    </div>
  `;

  let timer;
  const debounce = (fn) => (...a) => { clearTimeout(timer); timer = setTimeout(() => fn(...a), 250); };
  const search = wrap.querySelector('#user-search');
  const filter = wrap.querySelector('#state-filter');
  const reload = () => load(search.value, filter.value);
  search.addEventListener('input', debounce(reload));
  filter.addEventListener('change', reload);

  setContent(wrap);
  load();
}

async function viewAdmins() {
  setPageTitle('Administrators');
  const wrap = el(`<div></div>`);
  setContent(el(`<div class="loading-row"><span class="spinner"></span></div>`));

  async function loadTable() {
    let r;
    try { r = await api.listLocalAdmins(); }
    catch (err) {
      wrap.querySelector('#admins-tbody').innerHTML = `<tr><td colspan="5"><div class="alert alert-error">${esc(err.message)}</div></td></tr>`;
      return;
    }
    const rows = r.data || [];
    wrap.querySelector('#admins-tbody').innerHTML = rows.length ? rows.map((a) => `
      <tr>
        <td class="cell-strong">${esc(a.email)}</td>
        <td><span class="badge badge-info">${esc(a.role)}</span></td>
        <td>${a.active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">Inactive</span>'}</td>
        <td class="muted">${fmtDate(a.last_login_at)}</td>
        <td class="actions">${a.active ? `<button class="btn btn-sm btn-danger" data-id="${a.id}">Deactivate</button>` : ''}</td>
      </tr>
    `).join('') : `<tr><td colspan="5" class="empty-state">No local administrators</td></tr>`;

    wrap.querySelectorAll('[data-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Deactivate this administrator?')) return;
        try { await api.deactivateAdmin(btn.dataset.id); loadTable(); }
        catch (err) { alert(err.message); }
      });
    });
  }

  wrap.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Administrators</h1>
        <p class="subtitle">Local accounts that can access this IdP console</p>
      </div>
    </div>
    <details class="card" style="margin-bottom:1rem">
      <summary style="cursor:pointer;font-weight:600">Create local administrator</summary>
      <p class="subtitle" style="margin:0.5rem 0 1rem">Use sparingly. Prefer Google/Zoho SSO for employees.</p>
      <div id="ca-error"></div>
      <form id="ca-form">
        <div class="grid-2">
          <div class="field"><label>Full name</label><input name="fullName" required /></div>
          <div class="field"><label>Email</label><input name="email" type="email" required /></div>
          <div class="field"><label>Password (min 10)</label><input name="password" type="password" minlength="10" required /></div>
          <div class="field"><label>Role</label>
            <select name="role">
              <option value="ADMIN">ADMIN</option>
              <option value="SUPER_ADMIN">SUPER_ADMIN</option>
            </select>
          </div>
        </div>
        <button type="submit" class="btn btn-primary">Create administrator</button>
      </form>
    </details>
    <div class="table-wrap">
      <div class="table-toolbar"><strong>Local administrators</strong></div>
      <table>
        <thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Last login</th><th></th></tr></thead>
        <tbody id="admins-tbody"><tr><td colspan="5" class="loading-row"><span class="spinner"></span></td></tr></tbody>
      </table>
    </div>
  `;

  wrap.querySelector('#ca-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = wrap.querySelector('#ca-error');
    errEl.innerHTML = '';
    try {
      await api.createLocalAdmin(Object.fromEntries(new FormData(e.target)));
      errEl.innerHTML = `<div class="alert alert-success">Administrator created.</div>`;
      e.target.reset();
      loadTable();
    } catch (err) {
      errEl.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    }
  });

  setContent(wrap);
  loadTable();
}

async function viewAuth() {
  setPageTitle('Authentication');
  const wrap = el(`<div></div>`);
  setContent(el(`<div class="loading-row"><span class="spinner"></span></div>`));

  let s;
  try { s = await api.idpStatus(); }
  catch (err) {
    setContent(el(`<div class="alert alert-error">${esc(err.message)}</div>`));
    return;
  }

  wrap.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Authentication</h1>
        <p class="subtitle">SAML Identity Provider and OIDC connection status</p>
      </div>
    </div>

    <div class="grid-3">
      <div class="card">
        <h2>SAML 2.0 Identity Provider</h2>
        <p class="subtitle" style="margin-bottom:1rem">Issues SAML assertions to registered Service Providers</p>
        <div class="kv-list">
          <div class="kv"><div class="k">Status</div><div class="v">${s.samlEnabled ? '<span class="badge badge-success">Enabled</span>' : '<span class="badge badge-warning">Not configured</span>'}</div></div>
          <div class="kv"><div class="k">Public base URL</div><div class="v">${esc(s.publicBaseUrl || '—')}</div></div>
          <div class="kv"><div class="k">Entity ID</div><div class="v truncate" title="${esc(s.entityId || '')}">${esc(s.entityId || '—')}</div></div>
          <div class="kv"><div class="k">Metadata</div><div class="v">${s.metadataUrl ? `<a href="${esc(s.metadataUrl)}" target="_blank">${esc(s.metadataUrl)}</a>` : '—'}</div></div>
        </div>
        ${!s.samlEnabled ? `
          <div class="alert alert-warning" style="margin-top:1rem">
            <div>
              <div style="font-weight:500;margin-bottom:0.3rem">SAML keys missing</div>
              On the dev server, run <code>bash scripts/gen-saml-dev-keys.sh</code>, paste <code>SAML_IDP_PRIVATE_KEY_PEM</code> and <code>SAML_IDP_CERT_PEM</code> into <code>.env</code>, then restart the API.
            </div>
          </div>` : ''}
      </div>

      <div class="card">
        <h2>OIDC providers</h2>
        <p class="subtitle" style="margin-bottom:1rem">Federated login for end users</p>
        <div class="kv-list">
          <div class="kv"><div class="k">Google</div><div class="v"><a href="/auth/google">/auth/google</a></div></div>
          <div class="kv"><div class="k">Zoho</div><div class="v"><a href="/auth/zoho">/auth/zoho</a></div></div>
        </div>
        <p class="subtitle" style="margin-top:1rem">Configure <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code>, <code>ZOHO_CLIENT_ID</code> in <code>.env</code>.</p>
      </div>

      <div class="card">
        <h2>Local password login</h2>
        <p class="subtitle" style="margin-bottom:1rem">Email + password administrators</p>
        <div class="kv-list">
          <div class="kv"><div class="k">Endpoint</div><div class="v"><code>POST /auth/local/login</code></div></div>
          <div class="kv"><div class="k">Master admin</div><div class="v">From <code>MASTER_ADMIN_EMAIL</code> in <code>.env</code></div></div>
        </div>
      </div>
    </div>
  `;

  setContent(wrap);
}

async function viewAudit() {
  setPageTitle('Audit Logs');
  const wrap = el(`<div></div>`);
  wrap.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Audit Logs</h1>
        <p class="subtitle">SSO assertions and tamper-evident system audit trail</p>
      </div>
    </div>
    <div class="tabs">
      <button class="tab active" data-tab="saml">SSO assertions</button>
      <button class="tab" data-tab="system">System audit</button>
    </div>
    <div id="audit-content"><div class="loading-row"><span class="spinner"></span></div></div>
  `;
  setContent(wrap);

  async function loadSaml() {
    const target = wrap.querySelector('#audit-content');
    target.innerHTML = `<div class="loading-row"><span class="spinner"></span></div>`;
    try {
      const r = await api.samlAudit();
      const rows = r.data || [];
      const body = rows.length ? rows.map((r) => `
        <tr>
          <td class="muted">${fmtDate(r.ts)}</td>
          <td class="cell-strong">${esc(r.sp_name)}</td>
          <td>${esc(r.emp_name || r.emp_id)}<br><span class="muted" style="font-size:0.75rem">${esc(r.emp_email || '')}</span></td>
          <td><span class="badge badge-info">${esc(r.binding)}</span></td>
          <td class="muted truncate" title="${esc(r.relay_state || '')}">${esc(r.relay_state || '—')}</td>
        </tr>`).join('') : `<tr><td colspan="5" class="empty-state"><div class="empty-icon">⌖</div>No SSO activity yet</td></tr>`;
      target.innerHTML = `
        <div class="table-wrap">
          <table>
            <thead><tr><th>Time</th><th>Application</th><th>User</th><th>Binding</th><th>Relay state</th></tr></thead>
            <tbody>${body}</tbody>
          </table>
        </div>`;
    } catch (err) {
      target.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    }
  }

  async function loadSystem() {
    const target = wrap.querySelector('#audit-content');
    target.innerHTML = `<div class="loading-row"><span class="spinner"></span></div>`;
    try {
      const r = await api.systemAudit();
      const rows = r.data || [];
      const body = rows.length ? rows.map((r) => `
        <tr>
          <td class="muted">${fmtDate(r.ts)}</td>
          <td class="cell-strong">${esc(r.actor)}</td>
          <td><code>${esc(r.action)}</code></td>
          <td>${esc(r.target)}</td>
        </tr>`).join('') : `<tr><td colspan="4" class="empty-state">No audit entries yet</td></tr>`;
      target.innerHTML = `
        <div class="table-wrap">
          <table>
            <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead>
            <tbody>${body}</tbody>
          </table>
        </div>`;
    } catch (err) {
      target.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    }
  }

  wrap.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      wrap.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      if (tab.dataset.tab === 'saml') loadSaml();
      else loadSystem();
    });
  });
  loadSaml();
}

async function viewSettings() {
  setPageTitle('Account');
  const me = state.me;
  const isLocal = me.session?.iss === 'local';

  const wrap = el(`
    <div>
      <div class="page-header">
        <div>
          <h1>Account</h1>
          <p class="subtitle">Profile, security, sessions and capabilities</p>
        </div>
      </div>
      <div class="tabs">
        <button class="tab active" data-tab="profile">Profile</button>
        ${isLocal ? '<button class="tab" data-tab="security">Security</button>' : ''}
        <button class="tab" data-tab="sessions">Sessions</button>
        <button class="tab" data-tab="mfa">Two-factor</button>
      </div>
      <div id="settings-content"><div class="loading-row"><span class="spinner"></span></div></div>
    </div>
  `);
  setContent(wrap);

  const target = wrap.querySelector('#settings-content');

  function renderProfile() {
    target.innerHTML = `
      <div class="grid-3">
        <div class="card">
          <h2>Profile</h2>
          <div class="kv-list" style="margin-top:1rem">
            <div class="kv"><div class="k">Full name</div><div class="v">${esc(me.employee?.full_name || '—')}</div></div>
            <div class="kv"><div class="k">Email</div><div class="v">${esc(me.session?.email || '—')}</div></div>
            <div class="kv"><div class="k">Employee ID</div><div class="v"><code>${esc(me.employee?.emp_id || '—')}</code></div></div>
            <div class="kv"><div class="k">Role</div><div class="v"><span class="badge badge-info">${esc(me.employee?.role || 'USER')}</span></div></div>
            <div class="kv"><div class="k">Department</div><div class="v">${esc(me.employee?.dept_id || '—')}</div></div>
            <div class="kv"><div class="k">ILG state</div><div class="v">${ilgBadge(me.employee?.ilg_state)}</div></div>
          </div>
        </div>
        <div class="card">
          <h2>Sign-in method</h2>
          <div class="kv-list" style="margin-top:1rem">
            <div class="kv"><div class="k">Issuer</div><div class="v"><span class="badge badge-info">${esc(me.session?.iss || '—')}</span></div></div>
            <div class="kv"><div class="k">Subject</div><div class="v"><code class="truncate" title="${esc(me.session?.sub || '')}">${esc(me.session?.sub || '—')}</code></div></div>
            <div class="kv"><div class="k">Session expires</div><div class="v">${fmtDate(me.session?.expiresAt)}</div></div>
          </div>
        </div>
        <div class="card">
          <h2>Capabilities</h2>
          <div class="kv-list" style="margin-top:1rem">
            ${Object.entries(me.capabilities || {}).map(([k, v]) => `
              <div class="kv"><div class="k">${esc(k)}</div><div class="v">${typeof v === 'boolean' ? (v ? '<span class="badge badge-success">Yes</span>' : '<span class="badge badge-neutral">No</span>') : esc(v ?? '—')}</div></div>
            `).join('')}
          </div>
        </div>
      </div>
    `;
  }

  function renderSecurity() {
    if (!isLocal) {
      target.innerHTML = `<div class="alert alert-info">Password change is only available for local accounts. You signed in via <code>${esc(me.session?.iss || '')}</code>.</div>`;
      return;
    }
    target.innerHTML = `
      <div class="card" style="max-width:520px">
        <h2>Change password</h2>
        <p class="subtitle" style="margin-bottom:1rem">Minimum 10 characters. After change, other sessions remain active until you sign them out.</p>
        <div id="cp-error"></div>
        <form id="cp-form">
          <div class="field">
            <label>Current password</label>
            <input name="currentPassword" type="password" required autocomplete="current-password" />
          </div>
          <div class="field">
            <label>New password</label>
            <input name="newPassword" type="password" minlength="10" required autocomplete="new-password" />
          </div>
          <div class="field">
            <label>Confirm new password</label>
            <input name="confirm" type="password" minlength="10" required autocomplete="new-password" />
          </div>
          <button type="submit" class="btn btn-primary">Update password</button>
        </form>
      </div>
    `;
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

  async function renderSessions() {
    target.innerHTML = `<div class="loading-row"><span class="spinner"></span></div>`;
    try {
      const r = await api.listSessions();
      const rows = r.data || [];
      const body = rows.length ? rows.map((s) => `
        <tr>
          <td><code class="truncate" title="${esc(s.session_id)}">${esc(s.session_id.slice(0, 8))}…</code> ${s.isCurrent ? '<span class="badge badge-success">Current</span>' : ''}</td>
          <td><span class="badge badge-info">${esc(s.iss)}</span></td>
          <td class="muted">${fmtDate(s.last_active_at)}</td>
          <td class="muted">${fmtDate(s.expires_at)}</td>
          <td class="muted truncate" title="${esc(s.user_agent || '')}">${esc(s.ip || '—')}</td>
          <td class="actions"><button class="btn btn-sm btn-danger" data-revoke="${esc(s.session_id)}">${s.isCurrent ? 'Sign out' : 'Revoke'}</button></td>
        </tr>`).join('') : `<tr><td colspan="6" class="empty-state">No active sessions</td></tr>`;
      target.innerHTML = `
        <div class="table-wrap">
          <div class="table-toolbar"><strong>Active sessions</strong><span class="muted">${rows.length} session${rows.length === 1 ? '' : 's'}</span></div>
          <table>
            <thead><tr><th>Session</th><th>Issuer</th><th>Last active</th><th>Expires</th><th>IP</th><th></th></tr></thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      `;
      target.querySelectorAll('[data-revoke]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.revoke;
          if (!confirm('Revoke this session?')) return;
          try {
            await api.revokeSession(id);
            if (id === me.session?.sessionId) { location.href = '/login'; return; }
            renderSessions();
          } catch (err) { alert(err.message); }
        });
      });
    } catch (err) {
      target.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    }
  }

  async function renderMfa() {
    target.innerHTML = `<div class="loading-row"><span class="spinner"></span></div>`;
    let s;
    try { s = await api.mfaStatus(); }
    catch (err) {
      target.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
      return;
    }
    if (s.enabled) {
      target.innerHTML = `
        <div class="card" style="max-width:560px">
          <h2>Two-factor authentication</h2>
          <p class="subtitle" style="margin-bottom:1rem"><span class="badge badge-success">Enabled</span> Last used ${fmtDate(s.lastUsedAt)} · ${s.remainingBackupCodes} backup codes left</p>
          <button class="btn btn-secondary" id="mfa-regen">Regenerate backup codes</button>
          <button class="btn btn-danger" id="mfa-disable" style="margin-left:0.5rem">Disable two-factor</button>
          <div id="mfa-action-result" style="margin-top:1rem"></div>
        </div>
      `;
      target.querySelector('#mfa-disable').addEventListener('click', async () => {
        if (!confirm('Disable two-factor authentication? Your account will be less secure.')) return;
        await api.mfaDisable(); renderMfa();
      });
      target.querySelector('#mfa-regen').addEventListener('click', async () => {
        if (!confirm('Replace all backup codes? Old codes will stop working.')) return;
        try {
          const r = await api.mfaRegenCodes();
          target.querySelector('#mfa-action-result').innerHTML = `
            <div class="alert alert-warning">
              <div>
                <div style="font-weight:600;margin-bottom:0.5rem">Save these backup codes — shown only once</div>
                <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:0.4rem;font-family:var(--font-mono);font-size:0.9rem">
                  ${r.backupCodes.map((c) => `<div>${esc(c)}</div>`).join('')}
                </div>
              </div>
            </div>`;
        } catch (err) { alert(err.message); }
      });
      return;
    }

    target.innerHTML = `
      <div class="card" style="max-width:560px">
        <h2>Two-factor authentication</h2>
        <p class="subtitle" style="margin-bottom:1rem"><span class="badge badge-warning">Disabled</span> Adds a 6-digit code on every sign-in.</p>
        <button class="btn btn-primary" id="mfa-start">Enable two-factor</button>
        <div id="mfa-enroll-area"></div>
      </div>
    `;
    target.querySelector('#mfa-start').addEventListener('click', async () => {
      const area = target.querySelector('#mfa-enroll-area');
      try {
        const r = await api.mfaEnroll();
        area.innerHTML = `
          <div style="margin-top:1.25rem;padding-top:1.25rem;border-top:1px solid var(--border)">
            <p class="subtitle" style="margin-bottom:0.75rem">Scan the QR code with Google Authenticator, Authy, 1Password, etc.</p>
            <img src="${esc(r.qrDataUrl)}" alt="MFA QR code" style="background:white;padding:0.5rem;border-radius:8px" />
            <p class="subtitle" style="margin-top:0.75rem">Or enter this secret manually: <code>${esc(r.secret)}</code></p>
            <form id="mfa-confirm" style="margin-top:1rem">
              <div class="field">
                <label>Enter the 6-digit code from your app</label>
                <input name="code" required pattern="[0-9]{6}" inputmode="numeric" autocomplete="one-time-code" />
              </div>
              <button class="btn btn-primary" type="submit">Verify and enable</button>
            </form>
            <div id="mfa-confirm-result"></div>
          </div>
        `;
        area.querySelector('#mfa-confirm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const out = area.querySelector('#mfa-confirm-result');
          out.innerHTML = '';
          try {
            const code = new FormData(e.target).get('code');
            const r2 = await api.mfaConfirm(code);
            out.innerHTML = `
              <div class="alert alert-success" style="margin-top:1rem">Two-factor enabled.</div>
              <div class="alert alert-warning" style="margin-top:0.5rem">
                <div>
                  <div style="font-weight:600;margin-bottom:0.5rem">Save these backup codes — shown only once</div>
                  <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:0.4rem;font-family:var(--font-mono);font-size:0.9rem">
                    ${r2.backupCodes.map((c) => `<div>${esc(c)}</div>`).join('')}
                  </div>
                </div>
              </div>
              <button class="btn btn-secondary" id="mfa-done" style="margin-top:0.75rem">Done</button>
            `;
            out.querySelector('#mfa-done').addEventListener('click', () => renderMfa());
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
    if (name === 'profile')  renderProfile();
    else if (name === 'security') renderSecurity();
    else if (name === 'sessions') renderSessions();
    else if (name === 'mfa')  renderMfa();
  }

  wrap.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => showTab(tab.dataset.tab));
  });

  renderProfile();
}

/* ---------- Router ---------- */
function navigate(view) {
  state.view = view;
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
  });
  history.replaceState(null, '', view === 'dashboard' ? '/' : `/?v=${view}`);

  switch (view) {
    case 'dashboard': return viewDashboard();
    case 'apps':      return viewApps();
    case 'saml-apps': return viewSamlApps();
    case 'users':     return viewUsers();
    case 'admins':    return viewAdmins();
    case 'auth':      return viewAuth();
    case 'audit':     return viewAudit();
    case 'settings':  return viewSettings();
    default:          return viewDashboard();
  }
}

async function main() {
  const root = document.getElementById('app');
  const path = location.pathname.replace(/\/$/, '') || '/';

  if (path === '/login') {
    root.replaceChildren(renderLogin());
    return;
  }

  try {
    state.me = await api.me();
  } catch {
    location.href = '/login';
    return;
  }

  // Default landing: admins → dashboard, regular users → apps
  const isAdmin = ROLES_ADMIN.includes(state.me.employee?.role);
  const params = new URLSearchParams(location.search);
  const initialView = params.get('v') || (isAdmin ? 'dashboard' : 'apps');

  // Restrict admin-central legacy URL
  if (path === '/admin-central') {
    if (!isAdmin) { location.href = '/'; return; }
  }

  root.replaceChildren(buildShell(initialView));
  navigate(initialView);
}

main();
