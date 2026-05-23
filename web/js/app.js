const api = {
  async fetch(path, options = {}) {
    const res = await fetch(path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const body = res.headers.get('content-type')?.includes('json')
      ? await res.json()
      : await res.text();
    if (!res.ok) {
      const err = new Error(body?.error || res.statusText);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  },
  me: () => api.fetch('/api/me'),
  apps: () => api.fetch('/api/apps'),
  localLogin: (email, password) =>
    api.fetch('/auth/local/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => api.fetch('/auth/logout', { method: 'POST' }),
  listLocalAdmins: () => api.fetch('/api/admin/local-users'),
  createLocalAdmin: (data) =>
    api.fetch('/api/admin/local-users', { method: 'POST', body: JSON.stringify(data) }),
  bootstrapAdmin: (data) =>
    api.fetch('/api/admin/local-users/bootstrap', { method: 'POST', body: JSON.stringify(data) }),
  adminStatus: () => api.fetch('/api/admin/local-users/status'),
  deactivateAdmin: (id) =>
    api.fetch(`/api/admin/local-users/${id}`, { method: 'DELETE' }),
  idpStatus: () => api.fetch('/api/admin/saml-apps/status'),
  listSamlApps: () => api.fetch('/api/admin/saml-apps'),
  createSamlApp: (data) =>
    api.fetch('/api/admin/saml-apps', { method: 'POST', body: JSON.stringify(data) }),
  deactivateSamlApp: (id) =>
    api.fetch(`/api/admin/saml-apps/${id}`, { method: 'DELETE' }),
};

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

function route() {
  return location.pathname.replace(/\/$/, '') || '/';
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function bindLogout(root) {
  root.querySelector('#logout-link')?.addEventListener('click', async (e) => {
    e.preventDefault();
    await api.logout();
    location.href = '/login';
  });
}

function nav(user, active) {
  const isAdmin = user && ['ADMIN', 'SUPER_ADMIN'].includes(user.session?.role || user.employee?.role);
  return `
    <header>
      <div class="logo">Lens<span>kart</span> IdP</div>
      <nav>
        ${user ? `<a href="/" class="${active === 'home' ? 'active' : ''}">My Apps</a>` : ''}
        ${isAdmin ? `<a href="/admin-central" class="${active === 'admin' ? 'active' : ''}">Admin Central</a>` : ''}
        ${user ? `<a href="#" id="logout-link">Logout</a>` : `<a href="/login" class="${active === 'login' ? 'active' : ''}">Login</a>`}
      </nav>
    </header>`;
}

function renderLogin() {
  const root = el(`
    <div class="layout">
      ${nav(null, 'login')}
      <div class="card">
        <h1>Sign in</h1>
        <p class="subtitle">Local administrator or corporate SSO</p>
        <div id="login-error"></div>
        <form id="local-login-form">
          <div class="field">
            <label for="email">Email</label>
            <input id="email" name="email" type="email" required autocomplete="username" />
          </div>
          <div class="field">
            <label for="password">Password</label>
            <input id="password" name="password" type="password" required autocomplete="current-password" />
          </div>
          <button type="submit" class="btn btn-primary">Sign in with password</button>
        </form>
        <div class="divider">or</div>
        <a href="/auth/google" class="btn btn-secondary">Sign in with Google</a>
        <a href="/auth/zoho" class="btn btn-secondary">Sign in with Zoho</a>
      </div>
      <div class="card" id="bootstrap-card" style="display:none">
        <h1>First-time setup</h1>
        <p class="subtitle">Create the first super administrator (bootstrap)</p>
        <div id="bootstrap-error"></div>
        <form id="bootstrap-form">
          <div class="field"><label>Full name</label><input name="fullName" required /></div>
          <div class="field"><label>Email</label><input name="email" type="email" required /></div>
          <div class="field"><label>Password (min 10)</label><input name="password" type="password" minlength="10" required /></div>
          <div class="field"><label>Bootstrap token</label><input name="token" type="password" required /></div>
          <button type="submit" class="btn btn-primary">Create super admin</button>
        </form>
      </div>
    </div>
  `);

  root.querySelector('#local-login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const errEl = root.querySelector('#login-error');
    errEl.innerHTML = '';
    try {
      await api.localLogin(fd.get('email'), fd.get('password'));
      location.href = '/';
    } catch (err) {
      errEl.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    }
  });

  root.querySelector('#bootstrap-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const errEl = root.querySelector('#bootstrap-error');
    errEl.innerHTML = '';
    try {
      await api.bootstrapAdmin(Object.fromEntries(fd));
      errEl.innerHTML = `<div class="alert alert-success">Super admin created. Sign in above.</div>`;
      e.target.reset();
    } catch (err) {
      errEl.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    }
  });

  api.adminStatus().then((s) => {
    if (s.bootstrapEnabled) {
      root.querySelector('#bootstrap-card').style.display = 'block';
    }
  }).catch(() => {});

  return root;
}

function appTile(app) {
  const initial = (app.name || '?').charAt(0).toUpperCase();
  return `
    <a class="app-tile" href="${esc(app.launchUrl)}" target="_blank" rel="noopener">
      ${app.iconUrl
        ? `<img class="app-icon" src="${esc(app.iconUrl)}" alt="" />`
        : `<div class="app-icon app-icon-fallback">${esc(initial)}</div>`}
      <span class="app-name">${esc(app.name)}</span>
    </a>`;
}

async function renderHome(me) {
  const root = el(`
    <div class="layout layout-wide">
      ${nav(me, 'home')}
      <div class="portal-header">
        <div>
          <h1>My Applications</h1>
          <p class="subtitle">Single sign-on to your entitled enterprise apps</p>
        </div>
        <div class="profile-chip">
          <div class="profile-name">${esc(me.employee?.full_name || me.session.email)}</div>
          <div class="profile-meta">
            <span class="badge">${esc(me.employee?.role || 'USER')}</span>
            ${esc(me.session.email)}
          </div>
        </div>
      </div>
      <div id="apps-area">Loading applications…</div>
    </div>
  `);

  bindLogout(root);

  const area = root.querySelector('#apps-area');
  try {
    const appsResp = await api.apps();
    const apps = appsResp.data || [];

    if (!appsResp.samlEnabled) {
      area.innerHTML = `
        <div class="card wide">
          <h2>SAML IdP not configured</h2>
          <p class="subtitle">Application SSO requires SAML signing keys in <code>.env</code>.</p>
          <ol class="setup-steps">
            <li>On the server: <code>bash scripts/gen-saml-dev-keys.sh</code></li>
            <li>Add <code>SAML_IDP_PRIVATE_KEY_PEM</code> and <code>SAML_IDP_CERT_PEM</code> to <code>.env</code></li>
            <li>Restart API: <code>bash scripts/restart-api.sh</code></li>
            <li>Register apps in <a href="/admin-central?tab=apps">Admin Central → SAML Applications</a></li>
          </ol>
          ${me.capabilities?.canAdmin ? '<a href="/admin-central?tab=apps" class="btn btn-primary btn-inline">Open Admin Central</a>' : ''}
        </div>`;
      return root;
    }

    if (!apps.length) {
      area.innerHTML = `
        <div class="card wide">
          <h2>No applications yet</h2>
          <p class="subtitle">SAML IdP is ready. Register Service Providers to show app tiles here.</p>
          ${me.capabilities?.metadataUrl ? `<p class="subtitle">IdP metadata: <a href="${esc(me.capabilities.metadataUrl)}" target="_blank">${esc(me.capabilities.metadataUrl)}</a></p>` : ''}
          ${me.capabilities?.canAdmin
            ? '<a href="/admin-central?tab=apps" class="btn btn-primary btn-inline">Register SAML application</a>'
            : '<p class="subtitle">Contact your IdP administrator to register applications.</p>'}
        </div>`;
      return root;
    }

    area.innerHTML = `
      <div class="app-grid">
        ${apps.map(appTile).join('')}
      </div>
      <p class="subtitle portal-footer">
        Click an app to launch via SAML SSO · ${apps.length} application${apps.length === 1 ? '' : 's'}
      </p>`;
  } catch (err) {
    area.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }

  return root;
}

function adminTabs(active) {
  return `
    <div class="tabs">
      <button type="button" class="tab ${active === 'admins' ? 'active' : ''}" data-tab="admins">Administrators</button>
      <button type="button" class="tab ${active === 'apps' ? 'active' : ''}" data-tab="apps">SAML Applications</button>
      <button type="button" class="tab ${active === 'idp' ? 'active' : ''}" data-tab="idp">IdP Setup</button>
    </div>`;
}

function renderAdminPanel(me, tab = 'admins') {
  const isSuper = me.employee?.role === 'SUPER_ADMIN';
  const root = el(`
    <div class="layout layout-wide">
      ${nav(me, 'admin')}
      <div class="card wide">
        <h1>Admin Central</h1>
        <p class="subtitle">Identity governance &amp; SAML application management</p>
        ${adminTabs(tab)}
        <div id="tab-content"></div>
      </div>
    </div>
  `);

  bindLogout(root);

  const content = root.querySelector('#tab-content');

  function showTab(name) {
    history.replaceState(null, '', `/admin-central?tab=${name}`);
    root.querySelectorAll('.tab').forEach((t) => {
      t.classList.toggle('active', t.dataset.tab === name);
    });
    if (name === 'admins') renderAdminsTab();
    else if (name === 'apps') renderAppsTab();
    else renderIdpTab();
  }

  root.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  });

  async function renderAdminsTab() {
    content.innerHTML = `
      ${isSuper ? `
      <h2 class="section-title">Create local administrator</h2>
      <div id="create-error"></div>
      <form id="create-admin-form">
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
        <button type="submit" class="btn btn-primary btn-inline">Create administrator</button>
      </form>` : '<p class="subtitle">Only SUPER_ADMIN can create new administrators.</p>'}
      <h2 class="section-title">Local administrators</h2>
      <div id="admin-table">Loading…</div>`;

    async function loadTable() {
      const tableEl = content.querySelector('#admin-table');
      try {
        const { data } = await api.listLocalAdmins();
        if (!data.length) {
          tableEl.innerHTML = '<p class="subtitle">No local administrators yet.</p>';
          return;
        }
        tableEl.innerHTML = `
          <table>
            <thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Last login</th>${isSuper ? '<th></th>' : ''}</tr></thead>
            <tbody>
              ${data.map((a) => `
                <tr>
                  <td>${esc(a.email)}</td>
                  <td><span class="badge">${esc(a.role)}</span></td>
                  <td>${a.active ? 'Active' : 'Inactive'}</td>
                  <td>${esc(a.last_login_at || '—')}</td>
                  ${isSuper ? `<td>${a.active ? `<button class="btn btn-sm" data-id="${a.id}">Deactivate</button>` : ''}</td>` : ''}
                </tr>
              `).join('')}
            </tbody>
          </table>`;
        tableEl.querySelectorAll('[data-id]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            if (!confirm('Deactivate this administrator?')) return;
            await api.deactivateAdmin(btn.dataset.id);
            loadTable();
          });
        });
      } catch (err) {
        tableEl.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
      }
    }

    content.querySelector('#create-admin-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const errEl = content.querySelector('#create-error');
      errEl.innerHTML = '';
      try {
        await api.createLocalAdmin(Object.fromEntries(fd));
        errEl.innerHTML = `<div class="alert alert-success">Administrator created.</div>`;
        e.target.reset();
        loadTable();
      } catch (err) {
        errEl.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
      }
    });

    loadTable();
  }

  async function renderAppsTab() {
    if (!isSuper) {
      content.innerHTML = '<p class="subtitle">Only SUPER_ADMIN can manage SAML applications.</p>';
      return;
    }

    content.innerHTML = `
      <h2 class="section-title">Register SAML application</h2>
      <div id="sp-error"></div>
      <form id="create-sp-form">
        <div class="grid-2">
          <div class="field"><label>Application name</label><input name="name" required placeholder="e.g. Darwinbox HRMS" /></div>
          <div class="field"><label>Slug (URL-safe)</label><input name="slug" required pattern="[a-z0-9-]+" placeholder="e.g. darwinbox" /></div>
          <div class="field"><label>SP Entity ID</label><input name="entityId" required placeholder="https://app.example.com/saml/metadata" /></div>
          <div class="field"><label>ACS URL (Assertion Consumer)</label><input name="acsUrl" type="url" required placeholder="https://app.example.com/saml/acs" /></div>
          <div class="field"><label>SLO URL (optional)</label><input name="sloUrl" type="url" placeholder="https://app.example.com/saml/slo" /></div>
          <div class="field"><label>Icon URL (optional)</label><input name="iconUrl" type="url" placeholder="https://..." /></div>
        </div>
        <button type="submit" class="btn btn-primary btn-inline">Register application</button>
      </form>
      <h2 class="section-title">Registered applications</h2>
      <div id="sp-table">Loading…</div>`;

    async function loadSpTable() {
      const tableEl = content.querySelector('#sp-table');
      try {
        const { data } = await api.listSamlApps();
        if (!data.length) {
          tableEl.innerHTML = '<p class="subtitle">No SAML applications registered. Add one above — users will see entitled apps on My Apps.</p>';
          return;
        }
        tableEl.innerHTML = `
          <table>
            <thead><tr><th>Name</th><th>Slug</th><th>Entity ID</th><th>ACS URL</th><th>Status</th><th></th></tr></thead>
            <tbody>
              ${data.map((sp) => `
                <tr>
                  <td>${esc(sp.name)}</td>
                  <td><code>${esc(sp.slug)}</code></td>
                  <td class="truncate" title="${esc(sp.entity_id)}">${esc(sp.entity_id)}</td>
                  <td class="truncate" title="${esc(sp.acs_url)}">${esc(sp.acs_url)}</td>
                  <td>${sp.active ? '<span class="badge">Active</span>' : 'Inactive'}</td>
                  <td>${sp.active ? `<button class="btn btn-sm" data-sp-id="${esc(sp.id)}">Deactivate</button>` : ''}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>`;
        tableEl.querySelectorAll('[data-sp-id]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            if (!confirm('Deactivate this application?')) return;
            await api.deactivateSamlApp(btn.dataset.spId);
            loadSpTable();
          });
        });
      } catch (err) {
        tableEl.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
      }
    }

    content.querySelector('#create-sp-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const errEl = content.querySelector('#sp-error');
      errEl.innerHTML = '';
      const body = Object.fromEntries(fd);
      if (!body.sloUrl) delete body.sloUrl;
      if (!body.iconUrl) delete body.iconUrl;
      try {
        await api.createSamlApp(body);
        errEl.innerHTML = `<div class="alert alert-success">Application registered. Users can launch it from My Apps.</div>`;
        e.target.reset();
        loadSpTable();
      } catch (err) {
        errEl.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
      }
    });

    loadSpTable();
  }

  async function renderIdpTab() {
    content.innerHTML = '<p class="subtitle">Loading IdP status…</p>';
    try {
      const status = await api.idpStatus();
      content.innerHTML = `
        <h2 class="section-title">SAML Identity Provider</h2>
        <div class="status-grid">
          <div class="status-card">
            <div class="status-label">SAML IdP</div>
            <div class="status-value ${status.samlEnabled ? 'ok' : 'warn'}">${status.samlEnabled ? 'Enabled' : 'Not configured'}</div>
          </div>
          <div class="status-card">
            <div class="status-label">Public base URL</div>
            <div class="status-value">${esc(status.publicBaseUrl || '—')}</div>
          </div>
          <div class="status-card">
            <div class="status-label">Entity ID</div>
            <div class="status-value truncate">${esc(status.entityId || '—')}</div>
          </div>
        </div>
        ${status.metadataUrl ? `
          <p class="subtitle idp-meta">
            IdP metadata (give to every SAML app admin):
            <a href="${esc(status.metadataUrl)}" target="_blank">${esc(status.metadataUrl)}</a>
          </p>` : ''}
        ${!status.samlEnabled ? `
          <div class="alert alert-error idp-alert">
            SAML keys missing. Run on server:<br>
            <code>bash scripts/gen-saml-dev-keys.sh && nano .env</code><br>
            Set SAML_IDP_PRIVATE_KEY_PEM and SAML_IDP_CERT_PEM, then restart API.
          </div>` : `
          <p class="subtitle idp-meta">
            SSO endpoints: <code>/saml/sso</code> · Launch: <code>/saml/launch/{slug}</code>
          </p>`}
        <h2 class="section-title">OAuth / OIDC login</h2>
        <p class="subtitle">Google: <code>/auth/google</code> · Zoho: <code>/auth/zoho</code></p>
        <p class="subtitle">Configure GOOGLE_CLIENT_ID / ZOHO_CLIENT_ID in <code>.env</code> for corporate login.</p>`;
    } catch (err) {
      content.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    }
  }

  showTab(tab);
  return root;
}

async function main() {
  const app = document.getElementById('app');
  const path = route();

  if (path === '/login') {
    app.replaceChildren(renderLogin());
    return;
  }

  let me = null;
  try {
    me = await api.me();
  } catch {
    location.href = '/login';
    return;
  }

  if (path === '/admin-central') {
    if (!['ADMIN', 'SUPER_ADMIN'].includes(me.employee?.role)) {
      location.href = '/';
      return;
    }
    const tab = new URLSearchParams(location.search).get('tab') || 'admins';
    app.replaceChildren(renderAdminPanel(me, tab));
    return;
  }

  const home = await renderHome(me);
  app.replaceChildren(home);
}

main();
