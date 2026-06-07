/* End-user views: Home (app launcher), My Access, Request Access, My Tasks, Settings. */
import { api } from './api.js?v=2026-06-07-groups-sync';
import { el, esc, fmtDate, ilgBadge, initials } from './ui.js';
import { icon } from './icons.js';
import { mountThemeMenu, themeOptionsHtml, wireThemePicker } from './theme.js';

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
        <div class="auth-theme-bar">
          <div class="theme-picker" id="theme-picker">
            <button type="button" class="theme-picker-btn theme-picker-btn--light" id="theme-picker-btn" title="Appearance" aria-label="Choose theme">
              <span class="i-wrap">${icon('palette')}</span>
            </button>
            <div class="theme-picker-menu theme-picker-menu--auth" id="theme-picker-menu" role="menu">
              <div class="theme-picker-heading">Theme</div>
              <div class="theme-picker-grid">${themeOptionsHtml()}</div>
            </div>
          </div>
        </div>
        <div class="auth-card" id="step-email">
          <h2>Sign in to Lenskart IdP</h2>
          <p class="muted">Enter your corporate email to continue.</p>
          <div id="login-error"></div>
          <form id="email-form">
            <div class="field">
              <label for="email">Work email</label>
              <input id="email" name="email" type="email" required autocomplete="username" placeholder="you@lenskart.com" />
            </div>
            <button type="submit" class="btn btn-primary btn-block btn-lg">Continue →</button>
          </form>
          <div style="text-align:center;margin-top:1rem">
            <a href="/auth/google" class="btn btn-secondary" style="width:100%">Continue with Google</a>
          </div>
        </div>
      </main>
    </div>
  `);

  mountThemeMenu(root);

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

  function showPasswordStep(email) {
    const initial = (email.trim().charAt(0) || '?').toUpperCase();
    const card = el(`
      <div class="auth-card" id="step-password">
        <div class="auth-avatar-circle">${esc(initial)}</div>
        <h2 style="text-align:center">Welcome back</h2>
        <div class="auth-email-chip">
          <span>${esc(email)}</span>
          <a href="#" id="back-to-email">· Not you?</a>
        </div>
        <div id="pw-error"></div>
        <form id="password-form">
          <div class="field">
            <label for="password">Password</label>
            <input id="password" name="password" type="password" required autocomplete="current-password" />
          </div>
          <button type="submit" class="btn btn-primary btn-block btn-lg">Sign in</button>
        </form>
      </div>
    `);
    panel.replaceChildren(card);
    card.querySelector('#password').focus();

    card.querySelector('#back-to-email').addEventListener('click', (e) => {
      e.preventDefault();
      showEmailStep();
    });

    const pwErr = card.querySelector('#pw-error');
    card.querySelector('#password-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      pwErr.innerHTML = '';
      const password = new FormData(e.target).get('password');
      try {
        const r = await api.localLogin(email, password);
        if (r && r.mfaRequired && r.challengeId) {
          renderMfaStep(r.challengeId, email);
          return;
        }
        location.href = '/';
      } catch (err) {
        pwErr.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
      }
    });
  }

  function showEmailStep() {
    const card = el(`
      <div class="auth-card" id="step-email">
        <h2>Sign in to Lenskart IdP</h2>
        <p class="muted">Enter your corporate email to continue.</p>
        <div id="login-error"></div>
        <form id="email-form">
          <div class="field">
            <label for="email">Work email</label>
            <input id="email" name="email" type="email" required autocomplete="username" placeholder="you@lenskart.com" />
          </div>
          <button type="submit" class="btn btn-primary btn-block btn-lg">Continue →</button>
        </form>
        <div style="text-align:center;margin-top:1rem">
          <a href="/auth/google" class="btn btn-secondary" style="width:100%">Continue with Google</a>
        </div>
      </div>
    `);
    panel.replaceChildren(card);
    wireEmailForm(card);
  }

  function wireEmailForm(card) {
    const errEl = card.querySelector('#login-error');
    card.querySelector('#email-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const email = new FormData(e.target).get('email');
      if (!email || !email.trim()) {
        errEl.innerHTML = `<div class="alert alert-error">Please enter your email address.</div>`;
        return;
      }
      showPasswordStep(email.trim());
    });
  }

  wireEmailForm(root.querySelector('#step-email'));

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

/* ---------- Home: app launcher (JumpCloud-style with favorites + search) ---------- */
export async function viewHome(me, content) {
  const isAdmin = ROLES_ADMIN.includes(me.employee?.role);

  let allApps = [];
  let samlEnabled = false;
  try {
    const r = await api.apps();
    samlEnabled = !!r.samlEnabled;
    allApps = r.data || [];
  } catch { /* ignore */ }

  let favs = JSON.parse(localStorage.getItem('idp_fav_apps') || '[]');
  let activeTab = 'all';
  let searchQ = '';

  function renderAppTile(app) {
    const fb = app.iconUrl || app.icon_url
      ? `<img class="app-icon" src="${esc(app.iconUrl || app.icon_url)}" alt="" onerror="this.style.display='none'" />`
      : `<div class="app-icon app-icon-fallback">${esc((app.name || '?').charAt(0).toUpperCase())}</div>`;
    const launch = app.launchUrl || (app.slug ? `/saml/launch/${app.slug}` : '#');
    const appKey = app.slug || app.name;
    const isFav = favs.includes(appKey);
    return `<div class="app-tile-wrap" style="position:relative">
      <a class="app-tile" href="${esc(launch)}" target="_blank" rel="noopener" title="${esc(app.name)}">
        <span class="saml-badge">S</span>${fb}
        <span class="app-name">${esc(app.name)}</span>
      </a>
      <button class="app-fav-btn ${isFav ? 'starred' : ''}" data-appkey="${esc(appKey)}" title="${isFav ? 'Remove from favorites' : 'Add to favorites'}">${isFav ? '★' : '☆'}</button>
    </div>`;
  }

  function renderApps() {
    const q = searchQ.toLowerCase();
    let items = allApps.filter((a) => !q || (a.name || '').toLowerCase().includes(q));
    if (activeTab === 'favs') {
      items = items.filter((a) => favs.includes(a.slug || a.name));
    }
    if (!items.length) {
      if (activeTab === 'favs') {
        return `<div class="empty-state"><span class="empty-icon">⭐</span><p>No favorites yet — hover over an app tile and click ☆ to add it here.</p></div>`;
      }
      if (!samlEnabled) {
        return `<p class="subtitle" style="text-align:center;padding:2rem 0">${isAdmin ? 'SAML IdP signing keys not configured — see Authentication.' : 'Contact your administrator to enable SSO.'}</p>`;
      }
      return `<div class="empty-state"><span class="empty-icon">◎</span><p>No applications match your search.</p></div>`;
    }
    return `<div class="app-grid">${items.map(renderAppTile).join('')}</div>`;
  }

  const wrap = el(`
    <div>
      <div class="welcome-banner">
        <div>
          <h1>Welcome, ${esc(me.employee?.full_name || me.session?.email || 'there')}</h1>
          <p>Your single sign-on launchpad. ${samlEnabled ? `${allApps.length} apps available` : 'SAML IdP is being configured by an administrator'}.</p>
        </div>
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
          <span class="badge badge-light">${esc(me.employee?.role || 'USER')}</span>
          <span class="badge badge-light">${esc(me.session?.iss || 'local')}</span>
        </div>
      </div>

      <div class="apps-section">
        <div class="home-toolbar">
          <input class="form-input" id="home-search" placeholder="Search applications…">
        </div>
        <div class="home-tabs">
          <button class="home-tab active" data-tab="all">All Apps</button>
          <button class="home-tab" data-tab="favs">⭐ Favorites</button>
        </div>
        <div id="apps-render"></div>
      </div>
    </div>
  `);

  const appsRender = wrap.querySelector('#apps-render');

  function redraw() {
    appsRender.innerHTML = renderApps();
    /* Wire fav buttons */
    appsRender.querySelectorAll('.app-fav-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const key = btn.dataset.appkey;
        const idx = favs.indexOf(key);
        if (idx === -1) {
          favs.push(key);
        } else {
          favs.splice(idx, 1);
        }
        localStorage.setItem('idp_fav_apps', JSON.stringify(favs));
        redraw();
      });
    });
  }

  wrap.querySelector('#home-search').addEventListener('input', (e) => {
    searchQ = e.target.value;
    redraw();
  });

  wrap.querySelectorAll('.home-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      activeTab = tab.dataset.tab;
      wrap.querySelectorAll('.home-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === activeTab));
      redraw();
    });
  });

  redraw();
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

/* ---------- Request Access — full catalog browser with SoD pre-check ---------- */
export async function viewRequestAccess(content) {
  const wrap = el(`
    <div>
      <div class="page-header">
        <div><h1>Request Access</h1><p class="subtitle">Browse the application catalog and request access with business justification</p></div>
      </div>

      <!-- search + filter bar -->
      <div class="card" style="margin-bottom:1.25rem;display:flex;gap:0.75rem;flex-wrap:wrap;align-items:center">
        <input class="form-input" id="ra-search" placeholder="Search applications…" style="flex:1;min-width:200px">
        <select class="form-select" id="ra-type" style="width:auto">
          <option value="">All types</option>
          <option value="APP">Applications</option>
          <option value="ENTITLEMENT">Entitlements</option>
          <option value="ROLE">Business Roles</option>
        </select>
      </div>

      <div id="ra-catalog"><div class="loading-row"><span class="spinner"></span></div></div>

      <!-- request drawer (hidden by default) -->
      <div id="ra-drawer" style="display:none;position:fixed;right:0;top:0;height:100%;width:420px;max-width:100vw;background:var(--surface);border-left:1px solid var(--border);box-shadow:-4px 0 16px rgba(0,0,0,.15);z-index:200;overflow-y:auto">
        <div style="padding:1.5rem">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem">
            <h2 style="margin:0" id="ra-d-title">Request access</h2>
            <button id="ra-d-close" class="btn btn-sm btn-secondary">✕</button>
          </div>
          <div id="ra-d-body"></div>
        </div>
      </div>
    </div>`);
  content.replaceChildren(wrap);

  // Close drawer
  wrap.querySelector('#ra-d-close').addEventListener('click', () => {
    wrap.querySelector('#ra-drawer').style.display = 'none';
  });

  // Filter / search
  let allItems = [];
  function renderCatalog() {
    const q = (wrap.querySelector('#ra-search').value || '').toLowerCase();
    const type = wrap.querySelector('#ra-type').value;
    const filtered = allItems.filter(item => {
      const matchQ = !q || (item.name||'').toLowerCase().includes(q) || (item.description||'').toLowerCase().includes(q);
      const matchT = !type || item._type === type;
      return matchQ && matchT;
    });
    if (!filtered.length) {
      wrap.querySelector('#ra-catalog').innerHTML = `<div class="empty-state"><div class="empty-icon">◎</div><p>No matching items.</p></div>`;
      return;
    }
    // Group by type
    const groups = { APP: [], ENTITLEMENT: [], ROLE: [] };
    filtered.forEach(i => (groups[i._type] || (groups.OTHER = groups.OTHER||[])).push(i));
    const typeLabel = { APP: 'Applications', ENTITLEMENT: 'Entitlements', ROLE: 'Business Roles' };
    let html = '';
    for (const [t, items] of Object.entries(groups)) {
      if (!items.length) continue;
      html += `<h3 class="section-title">${typeLabel[t] || t}</h3>
        <div class="grid-3" style="margin-bottom:1.5rem">
          ${items.map(item => `
            <div class="card" style="cursor:pointer;transition:box-shadow .15s" data-req-id="${esc(String(item.id))}" data-req-type="${esc(item._type)}">
              <div style="display:flex;gap:0.75rem;align-items:flex-start">
                ${item.icon_url ? `<img src="${esc(item.icon_url)}" alt="" style="width:36px;height:36px;border-radius:6px;object-fit:cover;flex-shrink:0" onerror="this.style.display='none'">` : `<div style="width:36px;height:36px;border-radius:6px;background:var(--primary);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;flex-shrink:0">${esc((item.name||'?').charAt(0).toUpperCase())}</div>`}
                <div style="flex:1;min-width:0">
                  <div style="font-weight:600;margin-bottom:0.25rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.name)}</div>
                  <div class="muted" style="font-size:0.78rem;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${esc(item.description||'')}</div>
                </div>
              </div>
              <div style="margin-top:0.75rem;display:flex;justify-content:space-between;align-items:center">
                <span class="badge badge-info">${esc(item._type)}</span>
                <button class="btn btn-sm btn-primary req-btn" data-req-id="${esc(String(item.id))}" data-req-type="${esc(item._type)}" data-req-name="${esc(item.name)}">Request</button>
              </div>
            </div>`).join('')}
        </div>`;
    }
    wrap.querySelector('#ra-catalog').innerHTML = html;
    wrap.querySelectorAll('.req-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openRequestDrawer(btn.dataset.reqId, btn.dataset.reqType, btn.dataset.reqName);
      });
    });
  }

  function openRequestDrawer(id, type, name) {
    const drawer = wrap.querySelector('#ra-drawer');
    wrap.querySelector('#ra-d-title').textContent = `Request: ${name}`;
    const now = new Date();
    const defEnd = new Date(now);
    defEnd.setMonth(defEnd.getMonth() + 6);
    const fmt = d => d.toISOString().slice(0,10);
    wrap.querySelector('#ra-d-body').innerHTML = `
      <div class="form-group">
        <label class="form-label">Request for (optional — defaults to you)</label>
        <input class="form-input" id="ra-target" placeholder="Employee ID (leave blank for self)">
      </div>
      <div class="form-group">
        <label class="form-label">Justification <span style="color:var(--danger)">*</span></label>
        <textarea class="form-textarea" id="ra-just" rows="4" placeholder="Briefly explain why you need this access…"></textarea>
      </div>
      <div class="form-group">
        <label class="form-label">Validity period</label>
        <div style="display:flex;gap:0.5rem">
          <div style="flex:1"><label class="form-label" style="font-size:0.8rem">From</label><input class="form-input" id="ra-from" type="date" value="${fmt(now)}"></div>
          <div style="flex:1"><label class="form-label" style="font-size:0.8rem">Until</label><input class="form-input" id="ra-until" type="date" value="${fmt(defEnd)}"></div>
        </div>
      </div>
      <div id="ra-sod-check" style="margin-bottom:1rem"></div>
      <div id="ra-req-msg" style="margin-bottom:1rem"></div>
      <div style="display:flex;gap:0.5rem">
        <button class="btn btn-primary" id="ra-submit" style="flex:1">Submit Request</button>
        <button class="btn btn-secondary" id="ra-d-cancel">Cancel</button>
      </div>`;
    drawer.style.display = 'block';
    wrap.querySelector('#ra-d-cancel').addEventListener('click', () => { drawer.style.display = 'none'; });
    wrap.querySelector('#ra-submit').addEventListener('click', async () => {
      const just = wrap.querySelector('#ra-just').value.trim();
      const targetInput = wrap.querySelector('#ra-target').value.trim();
      if (!just) { wrap.querySelector('#ra-req-msg').innerHTML = `<div class="alert alert-error">Justification is required.</div>`; return; }
      const btn = wrap.querySelector('#ra-submit');
      btn.disabled = true; btn.textContent = 'Submitting…';
      wrap.querySelector('#ra-req-msg').innerHTML = '';
      wrap.querySelector('#ra-sod-check').innerHTML = '';
      try {
        await api.igaSubmitRequest({
          itemType: type,
          itemIds: [id],
          justification: just,
          ...(targetInput ? { targetEmpId: targetInput } : {}),
        });
        wrap.querySelector('#ra-req-msg').innerHTML = `<div class="alert alert-success">✓ Request submitted! Your manager will be notified for approval.</div>`;
        btn.disabled = false; btn.textContent = 'Submit Another';
      } catch(err) {
        const isSOD = err.message?.includes('SOD_VIOLATION') || err.code === 'SOD_VIOLATION';
        if (isSOD) {
          wrap.querySelector('#ra-sod-check').innerHTML = `<div class="alert alert-error" style="border-left:4px solid var(--danger)">
            <strong>⚠ SoD Policy Violation Detected</strong><br>
            <span style="font-size:0.875rem">${esc(err.message||'This access conflicts with an existing entitlement under your SoD policy.')}</span>
          </div>`;
        } else {
          wrap.querySelector('#ra-req-msg').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
        }
        btn.disabled = false; btn.textContent = 'Submit Request';
      }
    });
  }

  // Load catalog — apps + entitlements + roles
  try {
    const [appsR, entsR, rolesR] = await Promise.all([
      api.igaApps().catch(() => ({ data: [] })),
      api.igaEntitlements().catch(() => ({ data: [] })),
      api.listBusinessRoles().catch(() => ({ data: [] })),
    ]);
    const apps = (appsR.data || []).filter(a => a.active);
    const ents = (entsR.data || []);
    const roles = (rolesR.data || []).filter(r => r.active);
    allItems = [
      ...apps.map(a => ({ ...a, _type: 'APP' })),
      ...ents.map(e => ({ ...e, _type: 'ENTITLEMENT' })),
      ...roles.map(r => ({ ...r, _type: 'ROLE' })),
    ];
    if (!allItems.length) {
      wrap.querySelector('#ra-catalog').innerHTML = `<div class="empty-state"><div class="empty-icon">◎</div><p>No items in the catalog yet. Ask an admin to onboard applications.</p></div>`;
    } else {
      renderCatalog();
    }
    wrap.querySelector('#ra-search').addEventListener('input', renderCatalog);
    wrap.querySelector('#ra-type').addEventListener('change', renderCatalog);
  } catch(err) {
    wrap.querySelector('#ra-catalog').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
}

/* ---------- My Tasks — approvals + access review certifications ---------- */
export async function viewMyTasks(content) {
  const wrap = el(`
    <div>
      <div class="page-header"><div>
        <h1>My Tasks</h1><p class="subtitle">Pending approvals and access review certifications assigned to you</p>
      </div></div>
      <h3 class="section-title">Access request approvals</h3>
      <div id="t-approvals"><div class="loading-row"><span class="spinner"></span></div></div>
      <h3 class="section-title">Access review items</h3>
      <div id="t-reviews"><div class="loading-row"><span class="spinner"></span></div></div>
    </div>`);
  content.replaceChildren(wrap);

  /* ── Access request approvals ── */
  async function loadApprovals() {
    try {
      const r = await api.igaMyTasks();
      const rows = r.data || [];
      if (!rows.length) {
        wrap.querySelector('#t-approvals').innerHTML = `<div class="card empty-state"><span class="empty-icon">◐</span>No pending approvals — you're all caught up!</div>`;
        return;
      }
      wrap.querySelector('#t-approvals').innerHTML = `<div class="table-wrap"><table>
        <thead><tr><th>Request ID</th><th>Requester</th><th>For</th><th>Type / Items</th><th>Submitted</th><th>Actions</th></tr></thead>
        <tbody>${rows.map((r) => `<tr data-rid="${esc(String(r.id))}">
          <td><code style="font-size:0.8rem">${esc(String(r.id).slice(0,8))}…</code></td>
          <td class="cell-strong">${esc(r.requester_name || r.requester_emp_id || '—')}</td>
          <td class="muted">${esc(r.target_name || r.target_emp_id || 'Self')}</td>
          <td><span class="badge badge-info">${esc(r.item_type||'—')}</span></td>
          <td class="muted">${fmtDate(r.created_at)}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-sm btn-success approve-btn" data-id="${esc(String(r.id))}">✓ Approve</button>
            <button class="btn btn-sm btn-danger reject-btn" style="margin-left:0.25rem" data-id="${esc(String(r.id))}">✗ Reject</button>
          </td>
        </tr>`).join('')}</tbody></table></div>
      <div id="appr-msg" style="margin-top:0.75rem"></div>`;

      function decisionRow(id, decision) {
        const row = wrap.querySelector(`tr[data-rid="${id}"]`);
        if (!row) return;
        const existing = wrap.querySelector('#appr-reason-row-' + id.slice(0,8));
        if (existing) { existing.remove(); return; }
        const reasonRow = document.createElement('tr');
        reasonRow.id = 'appr-reason-row-' + id.slice(0,8);
        reasonRow.innerHTML = `<td colspan="6" style="background:var(--bg);padding:0.75rem 1rem">
          <div style="display:flex;gap:0.5rem;align-items:center">
            <input class="form-input" id="appr-reason-${esc(id.slice(0,8))}" placeholder="${decision === 'APPROVE' ? 'Optional comment' : 'Reason for rejection (required)'}" style="flex:1">
            <button class="btn btn-sm ${decision==='APPROVE'?'btn-success':'btn-danger'} confirm-decision" data-id="${esc(id)}" data-decision="${decision}">Confirm ${decision === 'APPROVE' ? 'Approval' : 'Rejection'}</button>
            <button class="btn btn-sm btn-secondary cancel-reason" data-id="${esc(id)}">Cancel</button>
          </div>
        </td>`;
        row.after(reasonRow);
        wrap.querySelector('.cancel-reason[data-id="'+id+'"]').addEventListener('click', () => reasonRow.remove());
        wrap.querySelector('.confirm-decision[data-id="'+id+'"]').addEventListener('click', async () => {
          const comment = wrap.querySelector('#appr-reason-' + id.slice(0,8)).value.trim();
          if (decision === 'REJECT' && !comment) {
            wrap.querySelector('#appr-msg').innerHTML = `<div class="alert alert-error">Rejection reason is required.</div>`; return;
          }
          try {
            await api.igaRequestDecision(id, decision, comment || undefined);
            wrap.querySelector('#appr-msg').innerHTML = `<div class="alert alert-success">Decision recorded.</div>`;
            setTimeout(() => loadApprovals(), 1200);
          } catch(e) {
            wrap.querySelector('#appr-msg').innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
          }
        });
      }

      wrap.querySelectorAll('.approve-btn').forEach(btn => btn.addEventListener('click', () => decisionRow(btn.dataset.id, 'APPROVE')));
      wrap.querySelectorAll('.reject-btn').forEach(btn => btn.addEventListener('click', () => decisionRow(btn.dataset.id, 'REJECT')));
    } catch(err) {
      wrap.querySelector('#t-approvals').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    }
  }

  /* ── Access review certifications ── */
  async function loadReviews() {
    try {
      const r = await api.igaMyReviews();
      const rows = r.data || [];
      if (!rows.length) {
        wrap.querySelector('#t-reviews').innerHTML = `<div class="card empty-state"><span class="empty-icon">✓</span>No active review items — nothing to certify</div>`;
        return;
      }
      wrap.querySelector('#t-reviews').innerHTML = `<div class="table-wrap"><table>
        <thead><tr><th>Campaign</th><th>Subject</th><th>Access Item</th><th>Due</th><th>Certify / Revoke</th></tr></thead>
        <tbody>${rows.map((r) => `<tr data-iid="${esc(String(r.id))}" data-cid="${esc(String(r.campaign_id))}">
          <td class="muted" style="font-size:0.85rem">${esc(r.campaign_name||'—')}</td>
          <td class="cell-strong">${esc(r.subject_name || r.emp_id || '—')}</td>
          <td>${esc(r.entitlement_name || r.role_name || '—')}</td>
          <td class="muted">${fmtDate(r.end_date)}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-sm btn-success certify-btn" data-iid="${esc(String(r.id))}" data-cid="${esc(String(r.campaign_id))}">✓ Certify</button>
            <button class="btn btn-sm btn-danger revoke-btn" style="margin-left:0.25rem" data-iid="${esc(String(r.id))}" data-cid="${esc(String(r.campaign_id))}">✗ Revoke</button>
          </td>
        </tr>`).join('')}</tbody></table></div>
      <div id="rev-msg" style="margin-top:0.75rem"></div>`;

      async function certifyItem(campaignId, itemId, decision) {
        try {
          await api.submitReviewDecision(campaignId, itemId, decision);
          wrap.querySelector('#rev-msg').innerHTML = `<div class="alert alert-success">${decision === 'CERTIFY' ? '✓ Access certified.' : '✗ Access revoked — will be removed at campaign close.'}</div>`;
          setTimeout(() => loadReviews(), 1000);
        } catch(e) {
          wrap.querySelector('#rev-msg').innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
        }
      }

      wrap.querySelectorAll('.certify-btn').forEach(btn => btn.addEventListener('click', () => certifyItem(btn.dataset.cid, btn.dataset.iid, 'CERTIFY')));
      wrap.querySelectorAll('.revoke-btn').forEach(btn => btn.addEventListener('click', () => certifyItem(btn.dataset.cid, btn.dataset.iid, 'REVOKE')));
    } catch(err) {
      wrap.querySelector('#t-reviews').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    }
  }

  loadApprovals();
  loadReviews();
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
        <button class="tab" data-tab="appearance">Appearance</button>
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
        <td class="muted" style="font-family:var(--mono,'JetBrains Mono',monospace)">${esc(s.ip || '—')}</td>
        <td class="muted">${esc(s.device_info || '—')}</td>
        <td class="muted">${esc(s.geo_location || '—')}</td>
        <td class="muted" style="font-family:var(--mono,'JetBrains Mono',monospace)">${esc(s.ip || '—')}</td>
        <td class="actions"><button class="btn btn-sm btn-danger" data-revoke="${esc(s.session_id)}">${s.isCurrent ? 'Sign out' : 'Revoke'}</button></td>
      </tr>`).join('') : `<tr><td colspan="7" class="empty-state"><span class="empty-icon">◌</span>No active sessions</td></tr>`;
      target.innerHTML = `<div class="table-wrap"><div class="table-toolbar">
        <strong>Active sessions</strong><span class="muted">${rows.length} session${rows.length === 1 ? '' : 's'}</span></div>
        <table><thead><tr><th>Session</th><th>Issuer</th><th>Last active</th><th>Expires</th><th>Device</th><th>Location</th><th>IP</th><th></th></tr></thead>
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
  function appearance() {
    target.innerHTML = `<div class="card" style="max-width:560px">
      <h2>Appearance</h2>
      <p class="subtitle" style="margin-bottom:1.25rem">Choose a colour theme for the portal. Your preference is saved on this device.</p>
      <div class="theme-picker-grid theme-picker-grid--settings">${themeOptionsHtml()}</div>
    </div>`;
    wireThemePicker(target);
  }
  function showTab(name) {
    wrap.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    if (name === 'profile') profile();
    else if (name === 'security') security();
    else if (name === 'sessions') sessions();
    else if (name === 'mfa') mfa();
    else if (name === 'appearance') appearance();
  }
  wrap.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => showTab(tab.dataset.tab)));
  profile();
}
