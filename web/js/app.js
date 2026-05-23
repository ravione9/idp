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
};

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

function route() {
  return location.pathname.replace(/\/$/, '') || '/';
}

function nav(user, active) {
  const isAdmin = user && ['ADMIN', 'SUPER_ADMIN'].includes(user.session?.role || user.employee?.role);
  return `
    <header>
      <div class="logo">Lens<span>kart</span> IdP</div>
      <nav>
        ${user ? `<a href="/" class="${active === 'home' ? 'active' : ''}">Home</a>` : ''}
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
      errEl.innerHTML = `<div class="alert alert-error">${err.message}</div>`;
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
      errEl.innerHTML = `<div class="alert alert-error">${err.message}</div>`;
    }
  });

  api.adminStatus().then((s) => {
    if (s.bootstrapEnabled) {
      root.querySelector('#bootstrap-card').style.display = 'block';
    }
  }).catch(() => {});

  return root;
}

function renderHome(me) {
  const role = me.employee?.role || me.session?.email;
  const root = el(`
    <div class="layout">
      ${nav(me, 'home')}
      <div class="home-hero">
        <h1>Welcome, ${me.employee?.full_name || me.session.email}</h1>
        <p>Signed in as <span class="badge">${me.employee?.role || 'USER'}</span> · ${me.session.email}</p>
        <div class="actions">
          ${me.capabilities?.canLaunchApps ? '<a href="/api/apps" class="btn btn-secondary">My apps (API)</a>' : ''}
          ${me.capabilities?.canAdmin ? '<a href="/admin-central" class="btn btn-primary">Admin Central</a>' : ''}
        </div>
      </div>
    </div>
  `);

  root.querySelector('#logout-link')?.addEventListener('click', async (e) => {
    e.preventDefault();
    await api.logout();
    location.href = '/login';
  });

  return root;
}

function renderAdmin(me) {
  const isSuper = me.employee?.role === 'SUPER_ADMIN';
  const root = el(`
    <div class="layout">
      ${nav(me, 'admin')}
      <div class="card wide">
        <h1>Admin Central</h1>
        <p class="subtitle">Manage local IdP administrators</p>
        ${isSuper ? `
        <h2 style="font-size:1rem;margin:1.5rem 0 0.75rem">Create local administrator</h2>
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
          <button type="submit" class="btn btn-primary" style="margin-top:0.5rem;width:auto;min-width:200px">Create administrator</button>
        </form>
        ` : '<p class="subtitle">Only SUPER_ADMIN can create new administrators.</p>'}
        <h2 style="font-size:1rem;margin:1.5rem 0 0.75rem">Local administrators</h2>
        <div id="admin-table">Loading…</div>
      </div>
    </div>
  `);

  async function loadTable() {
    const tableEl = root.querySelector('#admin-table');
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
                <td>${a.email}</td>
                <td><span class="badge">${a.role}</span></td>
                <td>${a.active ? 'Active' : 'Inactive'}</td>
                <td>${a.last_login_at || '—'}</td>
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
      tableEl.innerHTML = `<div class="alert alert-error">${err.message}</div>`;
    }
  }

  root.querySelector('#create-admin-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const errEl = root.querySelector('#create-error');
    errEl.innerHTML = '';
    try {
      await api.createLocalAdmin(Object.fromEntries(fd));
      errEl.innerHTML = `<div class="alert alert-success">Administrator created.</div>`;
      e.target.reset();
      loadTable();
    } catch (err) {
      errEl.innerHTML = `<div class="alert alert-error">${err.message}</div>`;
    }
  });

  root.querySelector('#logout-link')?.addEventListener('click', async (e) => {
    e.preventDefault();
    await api.logout();
    location.href = '/login';
  });

  loadTable();
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
    app.replaceChildren(renderAdmin(me));
    return;
  }

  app.replaceChildren(renderHome(me));
}

main();
