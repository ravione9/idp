/* Admin views: Dashboard, SAML apps, App catalog, Connectors, Users, Admins,
   Reviews, SoD, Risk, Authentication, Audit, Reports. */
import { api } from './api.js';
import { el, esc, fmtDate, fmtShortDate, ilgBadge, initials, build30DaySeries, renderLineChart, renderDonut } from './ui.js';

const ROLES_ADMIN = ['ADMIN', 'SUPER_ADMIN'];

function header(title, subtitle, action = '') {
  return `<div class="page-header">
    <div><h1>${esc(title)}</h1><p class="subtitle">${esc(subtitle)}</p></div>
    ${action}</div>`;
}

function statCard(icon, label, value, sub = '', cls = 'primary') {
  return `<div class="stat-card">
    <div class="stat-icon ${cls}">${icon}</div>
    <div>
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-value">${esc(String(value ?? 0))}</div>
      ${sub ? `<div class="stat-sub">${esc(sub)}</div>` : ''}
    </div>
  </div>`;
}

/* ---------- Dashboard ---------- */
export async function viewDashboard(content) {
  content.replaceChildren(el(`<div><div class="loading-row"><span class="spinner"></span></div></div>`));
  let d, ts, ins;
  try {
    [d, ts, ins] = await Promise.all([
      api.dashboard(),
      api.dashboardSeries().catch(() => ({ logins: [], ssos: [] })),
      api.sessionsInsight().catch(() => ({ active: 0, expired: 0, revoked: 0 })),
    ]);
  } catch (err) {
    content.replaceChildren(el(`<div class="alert alert-error">${esc(err.message)}</div>`));
    return;
  }
  const c = d.counts;
  const sys = d.system;

  const series = [build30DaySeries(ts.logins), build30DaySeries(ts.ssos)];
  const labels = series[0].map((p) => fmtShortDate(p.d));
  const lineSvg = renderLineChart({
    series: [series[0].map((p) => p.n), series[1].map((p) => p.n)],
    labels,
    colors: ['primary', 'accent'],
  });
  const donut = renderDonut(
    [
      { label: 'Active',  value: ins.active,  color: 'var(--success)' },
      { label: 'Expired', value: ins.expired, color: 'var(--text-dim)' },
      { label: 'Revoked', value: ins.revoked, color: 'var(--danger)' },
    ],
    'Total',
  );

  const recent = (d.recentAssertions || []).map((r) => `<tr>
    <td class="muted">${fmtDate(r.ts)}</td>
    <td class="cell-strong">${esc(r.sp_name)}</td>
    <td>${esc(r.emp_id)}</td>
    <td><span class="badge badge-info">${esc(r.binding)}</span></td>
  </tr>`).join('');
  const topApps = (d.topApps || []).map((a) => `<tr>
    <td class="cell-strong">${esc(a.name)}</td>
    <td><code>${esc(a.slug)}</code></td>
    <td>${a.n}</td>
  </tr>`).join('');

  const wrap = el(`<div>
    ${header('Dashboard', 'Overview of your identity and access management deployment')}

    <section class="stat-grid">
      ${statCard('◍', 'Total users',     c.employees,        `${c.activeEmployees} active`,        'primary')}
      ${statCard('⛨', 'SAML apps',       c.activeSamlApps,   `${c.samlApps} registered`,           'accent')}
      ${statCard('●', 'Active sessions', c.activeSessions,   'across all users',                   'success')}
      ${statCard('⌖', 'SSO logins (24h)', c.assertions24h,   `${c.assertions7d} in 7 days`,        'info')}
      ${statCard('◐', 'Pending tasks',   c.pendingApprovals + c.pendingReviews, 'approvals + reviews', 'warning')}
      ${statCard('⚠', 'SoD violations',  c.openSodViolations, 'open',                              'danger')}
      ${statCard('⚿', 'MFA enrolled',    c.mfaEnrolled,       'admins',                            'purple')}
      ${statCard('☰', 'Local admins',    c.localAdmins,       'console accounts',                  'teal')}
    </section>

    <div class="chart-row">
      <div class="chart-card">
        <div class="chart-header">
          <div class="chart-title">Session overview</div>
          <div class="chart-meta">Last 30 days</div>
        </div>
        ${lineSvg}
        <div class="legend"><span><span class="swatch primary"></span>Logins</span><span><span class="swatch accent"></span>SSO assertions</span></div>
      </div>
      <div class="chart-card">
        <div class="chart-header">
          <div class="chart-title">Sessions insight</div>
        </div>
        <div class="donut-wrap">${donut}</div>
      </div>
    </div>

    <div class="grid-3">
      <div class="card" style="grid-column: span 2; min-width:0">
        <h2>Recent SSO activity</h2>
        <p class="subtitle" style="margin-bottom:0.75rem">Latest SAML assertions issued by the IdP</p>
        ${recent ? `<table><thead><tr><th>Time</th><th>Application</th><th>User</th><th>Binding</th></tr></thead><tbody>${recent}</tbody></table>` : `<div class="empty-state"><span class="empty-icon">⌖</span>No SSO assertions yet</div>`}
      </div>
      <div class="card">
        <h2>Top apps (7 days)</h2>
        ${topApps ? `<table><thead><tr><th>App</th><th>Slug</th><th>Logins</th></tr></thead><tbody>${topApps}</tbody></table>` : `<div class="empty-state">No data yet</div>`}
      </div>
      <div class="card" style="grid-column: span 3">
        <h2>System status</h2>
        <div class="grid-3" style="margin-top:0.75rem">
          <div class="kv"><div class="k">SAML IdP</div><div class="v">${sys.samlEnabled ? '<span class="badge badge-success">Enabled</span>' : '<span class="badge badge-warning">Not configured</span>'}</div></div>
          <div class="kv"><div class="k">Public base URL</div><div class="v truncate">${esc(sys.publicBaseUrl || '—')}</div></div>
          <div class="kv"><div class="k">Metadata</div><div class="v">${sys.metadataUrl ? `<a href="${esc(sys.metadataUrl)}" target="_blank">Open</a>` : '—'}</div></div>
          <div class="kv"><div class="k">Google OIDC</div><div class="v">${sys.googleConfigured ? '<span class="badge badge-success">Configured</span>' : '<span class="badge badge-neutral">Not configured</span>'}</div></div>
          <div class="kv"><div class="k">Zoho Mail SAML</div><div class="v">${sys.zohoSamlConfigured ? '<span class="badge badge-success">Registered</span>' : '<span class="badge badge-neutral">Not registered</span>'}</div></div>
        </div>
      </div>
    </div>
  </div>`);
  content.replaceChildren(wrap);
}

/* ---------- Application Catalog (IGA) ---------- */
export async function viewIgaApps(content) {
  const wrap = el(`<div>${header('Application Catalog', 'Protocol-agnostic registry. Each app may have one or more SAML / OIDC / SCIM bindings.')}<div id="ac-list"><div class="loading-row"><span class="spinner"></span></div></div></div>`);
  content.replaceChildren(wrap);
  try {
    const r = await api.igaApps();
    const rows = r.data || [];
    wrap.querySelector('#ac-list').innerHTML = rows.length
      ? `<div class="table-wrap"><table>
          <thead><tr><th>Name</th><th>Slug</th><th>Category</th><th>Visibility</th><th>SSO</th><th>Provisioning</th><th>Protocols</th><th>Status</th></tr></thead>
          <tbody>${rows.map((a) => `<tr>
            <td class="cell-strong">${esc(a.name)}</td>
            <td><code>${esc(a.slug)}</code></td>
            <td>${esc(a.category || '—')}</td>
            <td><span class="badge badge-neutral">${esc(a.visibility)}</span></td>
            <td>${a.sso_enabled ? '<span class="badge badge-success">On</span>' : '—'}</td>
            <td>${a.provisioning ? '<span class="badge badge-info">On</span>' : '—'}</td>
            <td>${a.protocol_count}</td>
            <td>${a.active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">Inactive</span>'}</td>
          </tr>`).join('')}</tbody></table></div>`
      : `<div class="card empty-state"><span class="empty-icon">▦</span>No applications registered yet. SAML SPs from /admin/saml-apps appear here once migrated.</div>`;
  } catch (err) {
    wrap.querySelector('#ac-list').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
}

/* ---------- SAML Applications (legacy CRUD) ---------- */
export async function viewSamlApps(me, content) {
  const wrap = el(`<div>${header('SAML Applications', 'Service Providers registered with this Identity Provider')}<div id="sa-area"><div class="loading-row"><span class="spinner"></span></div></div></div>`);
  content.replaceChildren(wrap);

  let resp, status;
  try {
    [resp, status] = await Promise.all([api.listSamlApps(), api.idpStatus().catch(() => ({}))]);
  } catch (err) {
    wrap.querySelector('#sa-area').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    return;
  }
  const apps = resp.data || [];
  const isSuper = me.employee?.role === 'SUPER_ADMIN';

  const tableBody = apps.length
    ? apps.map((sp) => `<tr>
      <td class="cell-strong">${esc(sp.name)}</td>
      <td><code>${esc(sp.slug)}</code></td>
      <td class="truncate muted" title="${esc(sp.entity_id)}">${esc(sp.entity_id)}</td>
      <td class="truncate muted" title="${esc(sp.acs_url)}">${esc(sp.acs_url)}</td>
      <td>${sp.active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">Disabled</span>'}</td>
      <td class="actions">${isSuper && sp.active ? `<button class="btn btn-sm btn-danger" data-sp-id="${esc(sp.id)}">Deactivate</button>` : ''}</td>
    </tr>`).join('')
    : `<tr><td colspan="6" class="empty-state"><span class="empty-icon">⛨</span>No SAML applications</td></tr>`;

  wrap.querySelector('#sa-area').innerHTML = `
    ${status.metadataUrl ? `<div class="alert alert-info" style="margin-bottom:1.5rem"><div>
      <div style="font-weight:500;margin-bottom:0.2rem">IdP metadata for SP onboarding</div>
      <a href="${esc(status.metadataUrl)}" target="_blank">${esc(status.metadataUrl)}</a></div></div>` : ''}
    ${isSuper ? `<details class="card" style="margin-bottom:1rem">
      <summary style="cursor:pointer;font-weight:600">Register new SAML application</summary>
      <p class="subtitle" style="margin:0.5rem 0 1rem">Add a Service Provider so users can launch it via SSO.</p>
      <div id="sp-error"></div>
      <form id="sp-form">
        <div class="grid-2">
          <div class="field"><label>Application name</label><input name="name" required placeholder="e.g. Darwinbox HRMS" /></div>
          <div class="field"><label>Slug</label><input name="slug" required pattern="[a-z0-9-]+" placeholder="e.g. darwinbox" /></div>
          <div class="field"><label>SP Entity ID</label><input name="entityId" required placeholder="https://app.example.com/saml/metadata" /></div>
          <div class="field"><label>ACS URL</label><input name="acsUrl" type="url" required placeholder="https://app.example.com/saml/acs" /></div>
          <div class="field"><label>SLO URL (optional)</label><input name="sloUrl" type="url" /></div>
          <div class="field"><label>Icon URL (optional)</label><input name="iconUrl" type="url" /></div>
        </div>
        <button type="submit" class="btn btn-primary">Register application</button>
      </form>
    </details>` : ''}
    <div class="table-wrap">
      <div class="table-toolbar"><strong>Registered applications</strong><span class="muted">${apps.length} total</span></div>
      <table><thead><tr><th>Name</th><th>Slug</th><th>Entity ID</th><th>ACS URL</th><th>Status</th><th></th></tr></thead><tbody>${tableBody}</tbody></table>
    </div>`;

  if (isSuper) {
    wrap.querySelector('#sp-form')?.addEventListener('submit', async (e) => {
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
        setTimeout(() => viewSamlApps(me, content), 600);
      } catch (err) {
        errEl.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
      }
    });
  }
  wrap.querySelectorAll('[data-sp-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Deactivate this application?')) return;
      try { await api.deactivateSamlApp(btn.dataset.spId); viewSamlApps(me, content); }
      catch (err) { alert(err.message); }
    });
  });
}

/* ---------- Connectors ---------- */
export async function viewConnectors(content) {
  const wrap = el(`<div>${header('Connectors', 'Pluggable adapters to target systems (HRMS, AD, Google, Slack, AWS IAM, …)')}<div id="cn-list"><div class="loading-row"><span class="spinner"></span></div></div></div>`);
  content.replaceChildren(wrap);
  try {
    const r = await api.igaConnectors();
    const rows = r.data || [];
    wrap.querySelector('#cn-list').innerHTML = rows.length
      ? `<div class="table-wrap"><table>
          <thead><tr><th>Name</th><th>Type</th><th>Direction</th><th>Sync mode</th><th>Status</th><th>Last sync</th></tr></thead>
          <tbody>${rows.map((c) => `<tr>
            <td class="cell-strong">${esc(c.name)}</td>
            <td><span class="badge badge-info">${esc(c.connector_type)}</span></td>
            <td>${esc(c.direction)}</td>
            <td>${esc(c.sync_mode)}</td>
            <td>${({CONFIGURED:'<span class="badge badge-neutral">Configured</span>',CONNECTED:'<span class="badge badge-success">Connected</span>',ERROR:'<span class="badge badge-danger">Error</span>',DISABLED:'<span class="badge badge-neutral">Disabled</span>'})[c.status] || esc(c.status)}</td>
            <td class="muted">${fmtDate(c.last_sync_at)}</td>
          </tr>`).join('')}</tbody></table></div>`
      : `<div class="card empty-state"><span class="empty-icon">⇄</span>No connectors registered. Connector dispatcher ships in Phase 2.</div>`;
  } catch (err) {
    wrap.querySelector('#cn-list').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
}

/* ---------- Users ---------- */
export async function viewUsers(content) {
  const wrap = el(`<div>${header('Users', 'Employees synced from HRMS, plus local IdP administrators')}
    <div class="table-wrap" id="users-table">
      <div class="table-toolbar">
        <div class="search-input"><input id="user-search" type="search" placeholder="Search by name, email, employee ID…" /></div>
        <div style="display:flex;gap:0.5rem;align-items:center">
          <select id="state-filter" class="btn btn-secondary" style="padding:0.45rem 0.7rem">
            <option value="">All states</option><option value="ACTIVE">Active</option><option value="REACTIVATED">Reactivated</option>
            <option value="SUSPENDED_AUTO">Suspended (auto)</option><option value="PENDING_MGR">Pending manager</option>
            <option value="ESCALATED_HRBP">Escalated HRBP</option><option value="DEPARTED">Departed</option><option value="DEPROVISIONED">Deprovisioned</option>
          </select>
          <span id="users-count" class="muted"></span>
        </div>
      </div>
      <table><thead><tr><th>Name</th><th>Email</th><th>Department</th><th>Type</th><th>State</th><th>Admin role</th><th>Last login</th></tr></thead>
        <tbody><tr><td colspan="7" class="loading-row"><span class="spinner"></span></td></tr></tbody></table>
    </div></div>`);
  content.replaceChildren(wrap);

  async function load(q = '', state = '') {
    try {
      const r = await api.listUsers(q, state);
      const rows = r.data || [];
      wrap.querySelector('tbody').innerHTML = rows.length
        ? rows.map((u) => `<tr>
          <td><div style="display:flex;align-items:center;gap:0.6rem">
            <span class="avatar" style="width:30px;height:30px;font-size:0.7rem">${esc(initials(u.full_name))}</span>
            <div><div class="cell-strong">${esc(u.full_name)}</div><div class="muted" style="font-size:0.75rem">${esc(u.emp_id)}</div></div>
          </div></td>
          <td>${esc(u.email_corp)}</td><td>${esc(u.dept_id || '—')}</td><td>${esc(u.employment_type || '—')}</td>
          <td>${ilgBadge(u.ilg_state)}</td>
          <td>${u.admin_role ? `<span class="badge badge-info">${esc(u.admin_role)}</span>` : '<span class="muted">—</span>'}</td>
          <td class="muted">${fmtDate(u.last_login_at)}</td>
        </tr>`).join('')
        : `<tr><td colspan="7" class="empty-state"><span class="empty-icon">◍</span>No users found</td></tr>`;
      wrap.querySelector('#users-count').textContent = `${r.total} total`;
    } catch (err) {
      wrap.querySelector('tbody').innerHTML = `<tr><td colspan="7"><div class="alert alert-error">${esc(err.message)}</div></td></tr>`;
    }
  }
  let timer;
  const debounce = (fn) => (...a) => { clearTimeout(timer); timer = setTimeout(() => fn(...a), 250); };
  const search = wrap.querySelector('#user-search');
  const filter = wrap.querySelector('#state-filter');
  const reload = () => load(search.value, filter.value);
  search.addEventListener('input', debounce(reload));
  filter.addEventListener('change', reload);
  load();
}

/* ---------- Administrators ---------- */
export async function viewAdmins(content) {
  const wrap = el(`<div>${header('Administrators', 'Local accounts that can access this IdP console')}
    <details class="card" style="margin-bottom:1rem"><summary style="cursor:pointer;font-weight:600">Create local administrator</summary>
      <p class="subtitle" style="margin:0.5rem 0 1rem">Use sparingly. Prefer Google SSO for employees.</p>
      <div id="ca-error"></div>
      <form id="ca-form">
        <div class="grid-2">
          <div class="field"><label>Full name</label><input name="fullName" required /></div>
          <div class="field"><label>Email</label><input name="email" type="email" required /></div>
          <div class="field"><label>Password (min 10)</label><input name="password" type="password" minlength="10" required /></div>
          <div class="field"><label>Role</label><select name="role"><option value="ADMIN">ADMIN</option><option value="SUPER_ADMIN">SUPER_ADMIN</option></select></div>
        </div>
        <button type="submit" class="btn btn-primary">Create administrator</button>
      </form>
    </details>
    <div class="table-wrap"><div class="table-toolbar"><strong>Local administrators</strong></div>
      <table><thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Last login</th><th></th></tr></thead>
      <tbody id="admins-tbody"><tr><td colspan="5" class="loading-row"><span class="spinner"></span></td></tr></tbody></table></div></div>`);
  content.replaceChildren(wrap);

  async function loadTable() {
    try {
      const r = await api.listLocalAdmins();
      const rows = r.data || [];
      wrap.querySelector('#admins-tbody').innerHTML = rows.length
        ? rows.map((a) => `<tr>
          <td class="cell-strong">${esc(a.email)}</td>
          <td><span class="badge badge-info">${esc(a.role)}</span></td>
          <td>${a.active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">Inactive</span>'}</td>
          <td class="muted">${fmtDate(a.last_login_at)}</td>
          <td class="actions">${a.active ? `<button class="btn btn-sm btn-danger" data-id="${a.id}">Deactivate</button>` : ''}</td>
        </tr>`).join('')
        : `<tr><td colspan="5" class="empty-state">No local administrators</td></tr>`;
      wrap.querySelectorAll('[data-id]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm('Deactivate this administrator?')) return;
          try { await api.deactivateAdmin(btn.dataset.id); loadTable(); }
          catch (err) { alert(err.message); }
        });
      });
    } catch (err) {
      wrap.querySelector('#admins-tbody').innerHTML = `<tr><td colspan="5"><div class="alert alert-error">${esc(err.message)}</div></td></tr>`;
    }
  }
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
  loadTable();
}

/* ---------- Authentication ---------- */
export async function viewAuth(content) {
  const wrap = el(`<div>${header('Authentication', 'SAML Identity Provider and OIDC connection status')}<div id="auth-area"><div class="loading-row"><span class="spinner"></span></div></div></div>`);
  content.replaceChildren(wrap);
  let s;
  try { s = await api.idpStatus(); }
  catch (err) { wrap.querySelector('#auth-area').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`; return; }

  wrap.querySelector('#auth-area').innerHTML = `<div class="grid-3">
    <div class="card"><h2>SAML 2.0 Identity Provider</h2>
      <p class="subtitle" style="margin-bottom:1rem">Issues SAML assertions to registered Service Providers</p>
      <div class="kv-list">
        <div class="kv"><div class="k">Status</div><div class="v">${s.samlEnabled ? '<span class="badge badge-success">Enabled</span>' : '<span class="badge badge-warning">Not configured</span>'}</div></div>
        <div class="kv"><div class="k">Public base URL</div><div class="v">${esc(s.publicBaseUrl || '—')}</div></div>
        <div class="kv"><div class="k">Entity ID</div><div class="v truncate" title="${esc(s.entityId || '')}">${esc(s.entityId || '—')}</div></div>
        <div class="kv"><div class="k">Metadata</div><div class="v">${s.metadataUrl ? `<a href="${esc(s.metadataUrl)}" target="_blank">Open</a>` : '—'}</div></div>
      </div>
      ${!s.samlEnabled ? `<div class="alert alert-warning" style="margin-top:1rem"><div>
        <div style="font-weight:500;margin-bottom:0.3rem">SAML keys missing</div>
        Run <code>bash scripts/gen-saml-dev-keys.sh</code>, paste <code>SAML_IDP_PRIVATE_KEY_PEM</code> and <code>SAML_IDP_CERT_PEM</code> into <code>.env</code>, then restart.</div></div>` : ''}
    </div>
    <div class="card"><h2>Inbound OIDC providers</h2>
      <p class="subtitle" style="margin-bottom:1rem">Federated login for end users</p>
      <div class="kv-list"><div class="kv"><div class="k">Google Workspace</div><div class="v"><a href="/auth/google">/auth/google</a></div></div></div>
      <p class="subtitle" style="margin-top:1rem">Configure <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code>, <code>GOOGLE_HOSTED_DOMAIN</code> in <code>.env</code>.</p>
      <p class="subtitle">Zoho Mail is consumed as a SAML application — see <a href="#" data-go="saml-apps">SAML Applications</a>.</p>
    </div>
    <div class="card"><h2>Local password login</h2>
      <p class="subtitle" style="margin-bottom:1rem">Email + password administrators</p>
      <div class="kv-list">
        <div class="kv"><div class="k">Endpoint</div><div class="v"><code>POST /auth/local/login</code></div></div>
        <div class="kv"><div class="k">Master admin</div><div class="v">From <code>MASTER_ADMIN_EMAIL</code> in <code>.env</code></div></div>
      </div>
    </div></div>`;
  wrap.querySelectorAll('[data-go]').forEach((a) => {
    a.addEventListener('click', (e) => { e.preventDefault(); window.LILG_NAV(a.dataset.go); });
  });
}

/* ---------- Audit ---------- */
export async function viewAudit(content) {
  const wrap = el(`<div>${header('Audit Logs', 'SSO assertions and tamper-evident system audit trail')}
    <div class="tabs"><button class="tab active" data-tab="saml">SSO assertions</button><button class="tab" data-tab="system">System audit</button></div>
    <div id="aud"><div class="loading-row"><span class="spinner"></span></div></div></div>`);
  content.replaceChildren(wrap);
  async function loadSaml() {
    const t = wrap.querySelector('#aud');
    t.innerHTML = `<div class="loading-row"><span class="spinner"></span></div>`;
    try {
      const r = await api.samlAudit(); const rows = r.data || [];
      t.innerHTML = rows.length
        ? `<div class="table-wrap"><table>
            <thead><tr><th>Time</th><th>Application</th><th>User</th><th>Binding</th><th>Relay state</th></tr></thead>
            <tbody>${rows.map((r) => `<tr>
              <td class="muted">${fmtDate(r.ts)}</td>
              <td class="cell-strong">${esc(r.sp_name)}</td>
              <td>${esc(r.emp_name || r.emp_id)}<br><span class="muted" style="font-size:0.75rem">${esc(r.emp_email || '')}</span></td>
              <td><span class="badge badge-info">${esc(r.binding)}</span></td>
              <td class="muted truncate" title="${esc(r.relay_state || '')}">${esc(r.relay_state || '—')}</td>
            </tr>`).join('')}</tbody></table></div>`
        : `<div class="card empty-state"><span class="empty-icon">⌖</span>No SSO activity yet</div>`;
    } catch (err) {
      t.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    }
  }
  async function loadSystem() {
    const t = wrap.querySelector('#aud');
    t.innerHTML = `<div class="loading-row"><span class="spinner"></span></div>`;
    try {
      const r = await api.systemAudit(); const rows = r.data || [];
      t.innerHTML = rows.length
        ? `<div class="table-wrap"><table>
            <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead>
            <tbody>${rows.map((r) => `<tr><td class="muted">${fmtDate(r.ts)}</td><td class="cell-strong">${esc(r.actor)}</td><td><code>${esc(r.action)}</code></td><td>${esc(r.target)}</td></tr>`).join('')}</tbody></table></div>`
        : `<div class="card empty-state">No audit entries yet</div>`;
    } catch (err) { t.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`; }
  }
  wrap.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
    wrap.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    if (tab.dataset.tab === 'saml') loadSaml(); else loadSystem();
  }));
  loadSaml();
}

/* ---------- Reviews / SoD / Risk / Reports ---------- */
async function simpleTable(content, title, subtitle, fetchFn, columns, render, emptyText, emptyIcon) {
  const wrap = el(`<div>${header(title, subtitle)}<div id="t-area"><div class="loading-row"><span class="spinner"></span></div></div></div>`);
  content.replaceChildren(wrap);
  try {
    const r = await fetchFn(); const rows = r.data || [];
    const head = `<thead><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>`;
    const body = rows.length
      ? rows.map((row) => `<tr>${render(row)}</tr>`).join('')
      : `<tr><td colspan="${columns.length}" class="empty-state"><span class="empty-icon">${emptyIcon}</span>${esc(emptyText)}</td></tr>`;
    wrap.querySelector('#t-area').innerHTML = `<div class="table-wrap"><table>${head}<tbody>${body}</tbody></table></div>`;
  } catch (err) {
    wrap.querySelector('#t-area').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
}

export async function viewReviews(content) {
  await simpleTable(
    content, 'Access Reviews', 'Quarterly certification campaigns — managers and app owners certify or revoke access',
    () => api.igaReviews(),
    ['Name', 'Reviewer kind', 'Period', 'Status', 'Items', 'Pending'],
    (c) => `<td class="cell-strong">${esc(c.name)}</td><td>${esc(c.reviewer_kind)}</td>
      <td class="muted">${fmtDate(c.start_date)} → ${fmtDate(c.end_date)}</td>
      <td>${({DRAFT:'<span class="badge badge-neutral">Draft</span>',ACTIVE:'<span class="badge badge-success">Active</span>',COMPLETED:'<span class="badge badge-info">Completed</span>',CANCELLED:'<span class="badge badge-danger">Cancelled</span>'})[c.status] || esc(c.status)}</td>
      <td>${c.item_count}</td><td>${c.pending_count}</td>`,
    'No campaigns yet. Create one in Phase 2.', '✓',
  );
}

export async function viewSod(content) {
  const wrap = el(`<div>${header('Segregation of Duties', 'Toxic combinations and policy violations')}
    <h3 class="section-title">Open violations</h3><div id="sod-v"><div class="loading-row"><span class="spinner"></span></div></div>
    <h3 class="section-title">Active policies</h3><div id="sod-p"><div class="loading-row"><span class="spinner"></span></div></div></div>`);
  content.replaceChildren(wrap);
  try {
    const v = await api.igaSodViolations(); const rows = v.data || [];
    wrap.querySelector('#sod-v').innerHTML = rows.length
      ? `<div class="table-wrap"><table><thead><tr><th>Severity</th><th>Policy</th><th>Employee</th><th>Detected</th></tr></thead>
          <tbody>${rows.map((r) => `<tr>
            <td>${({LOW:'<span class="badge badge-neutral">Low</span>',MEDIUM:'<span class="badge badge-info">Medium</span>',HIGH:'<span class="badge badge-warning">High</span>',CRITICAL:'<span class="badge badge-danger">Critical</span>'})[r.severity] || esc(r.severity)}</td>
            <td>${esc(r.policy_name)}</td>
            <td>${esc(r.emp_name || r.emp_id)}<br><span class="muted" style="font-size:0.75rem">${esc(r.email_corp || '')}</span></td>
            <td class="muted">${fmtDate(r.detected_at)}</td>
          </tr>`).join('')}</tbody></table></div>`
      : `<div class="card empty-state"><span class="empty-icon">⚠</span>No open violations. Detection job runs in Phase 2.</div>`;
  } catch (err) { wrap.querySelector('#sod-v').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`; }
  try {
    const p = await api.igaSodPolicies(); const rows = p.data || [];
    wrap.querySelector('#sod-p').innerHTML = rows.length
      ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Severity</th><th>Enforcement</th><th>Active</th></tr></thead>
          <tbody>${rows.map((r) => `<tr><td class="cell-strong">${esc(r.name)}</td><td>${esc(r.severity)}</td><td><span class="badge badge-neutral">${esc(r.enforcement)}</span></td><td>${r.active ? '<span class="badge badge-success">Yes</span>' : '<span class="badge badge-neutral">No</span>'}</td></tr>`).join('')}</tbody></table></div>`
      : `<div class="card empty-state">No policies defined. SoD authoring UI ships in Phase 2.</div>`;
  } catch (err) { wrap.querySelector('#sod-p').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`; }
}

export async function viewRisk(content) {
  const wrap = el(`<div>${header('Risk Dashboard', 'Login risk events and identities scoring above threshold')}<div id="rk"><div class="loading-row"><span class="spinner"></span></div></div></div>`);
  content.replaceChildren(wrap);
  try {
    const r = await api.igaRisk();
    wrap.querySelector('#rk').innerHTML = `
      <section class="stat-grid">
        ${statCard('◆', 'Identities at risk', (r.topRisk || []).length, 'score ≥ 50', 'warning')}
        ${statCard('◐', 'MFA challenged (24h)', r.counters?.mfaChallengeLast24h ?? 0, '', 'info')}
        ${statCard('⊘', 'Logins denied (24h)', r.counters?.deniedLast24h ?? 0, '', 'danger')}
      </section>
      <h3 class="section-title">High-risk identities</h3>
      ${(r.topRisk || []).length
        ? `<div class="table-wrap"><table><thead><tr><th>Identity</th><th>Email</th><th>Score</th><th>Last evaluated</th></tr></thead>
            <tbody>${r.topRisk.map((u) => `<tr>
              <td class="cell-strong">${esc(u.full_name || u.emp_id)}</td>
              <td>${esc(u.email_corp || '')}</td>
              <td><span class="badge ${u.score >= 80 ? 'badge-danger' : (u.score >= 60 ? 'badge-warning' : 'badge-info')}">${u.score}</span></td>
              <td class="muted">${fmtDate(u.updated_at)}</td>
            </tr>`).join('')}</tbody></table></div>`
        : `<div class="card empty-state"><span class="empty-icon">◆</span>No risk scores computed yet. Risk engine runs in Phase 3.</div>`}`;
  } catch (err) { wrap.querySelector('#rk').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`; }
}

export async function viewReports(content) {
  await simpleTable(
    content, 'Compliance Reports', 'SOX, GDPR, HIPAA evidence — generated snapshots',
    () => api.igaReports(),
    ['Name', 'Framework', 'Period', 'Generated', 'Artifact'],
    (r) => `<td class="cell-strong">${esc(r.name)}</td>
      <td><span class="badge badge-info">${esc(r.framework)}</span></td>
      <td class="muted">${fmtDate(r.period_start)} → ${fmtDate(r.period_end)}</td>
      <td class="muted">${fmtDate(r.generated_at)}</td>
      <td>${r.artifact_url ? `<a href="${esc(r.artifact_url)}" target="_blank">Download</a>` : '—'}</td>`,
    'No reports generated yet. Report generator ships in Phase 5.', '☰',
  );
}
