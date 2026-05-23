/* ============================================================
   Lenskart IdP Console — SPA entry point
   Layout: top nav (SailPoint-style) + admin sub-nav + content
   ============================================================ */
import { api } from './api.js';
import { el, esc, initials } from './ui.js';
import {
  renderLogin, viewHome, viewMyAccess, viewRequestAccess, viewMyTasks, viewSettings,
} from './views-end-user.js';
import {
  viewDashboard, viewSamlApps, viewIgaApps, viewConnectors, viewUsers, viewAdmins,
  viewReviews, viewSod, viewRisk, viewAuth, viewAudit, viewReports,
} from './views-admin.js';

const ROLES_ADMIN = ['ADMIN', 'SUPER_ADMIN'];

/* Map of route key → { label, primary, admin?, super?, view } */
const ROUTES = {
  /* Primary nav (visible to everyone) */
  home:      { label: 'Home',           primary: 'home',      end: viewHome },
  request:   { label: 'Request Center', primary: 'request',   end: viewRequestAccess },
  tasks:     { label: 'Approvals',      primary: 'tasks',     end: viewMyTasks },
  myaccess:  { label: 'My Access',      primary: 'myaccess',  end: viewMyAccess },
  reviews:   { label: 'Certifications', primary: 'reviews',   admin: true, view: viewReviews },

  /* Admin secondary nav */
  dashboard:    { label: 'Dashboard',         primary: 'admin', subnav: 'dashboard',    admin: true, view: viewDashboard },
  users:        { label: 'Identity',          primary: 'admin', subnav: 'users',        admin: true, view: viewUsers },
  admins:       { label: 'Administrators',    primary: 'admin', subnav: 'admins',       admin: true, super: true, view: viewAdmins },
  myaccessAdmin:{ label: 'Access Model',      primary: 'admin', subnav: 'myaccessAdmin', admin: true, view: (c) => viewMyAccess(c) },
  'iga-apps':   { label: 'Applications',      primary: 'admin', subnav: 'iga-apps',     admin: true, view: viewIgaApps },
  'saml-apps':  { label: 'SAML Apps',         primary: 'admin', subnav: 'saml-apps',    admin: true, view: viewSamlApps },
  connectors:   { label: 'Connections',       primary: 'admin', subnav: 'connectors',   admin: true, view: viewConnectors },
  'admin-cert': { label: 'Certifications',    primary: 'admin', subnav: 'admin-cert',   admin: true, view: viewReviews },
  auth:         { label: 'Password Mgmt',     primary: 'admin', subnav: 'auth',         admin: true, view: viewAuth },
  sod:          { label: 'Workflows',         primary: 'admin', subnav: 'sod',          admin: true, view: viewSod },
  risk:         { label: 'Risk',              primary: 'admin', subnav: 'risk',         admin: true, view: viewRisk },
  audit:        { label: 'Audit',             primary: 'admin', subnav: 'audit',        admin: true, view: viewAudit },
  reports:      { label: 'Reports',           primary: 'admin', subnav: 'reports',      admin: true, view: viewReports },

  /* Account (top-right dropdown) */
  settings:  { label: 'Account', view: viewSettings },
};

const PRIMARY_NAV_ORDER = ['home', 'request', 'tasks', 'reviews']; // last is "Admin" (handled separately)
const ADMIN_SUBNAV_ORDER = [
  'dashboard', 'users', 'admins', 'iga-apps', 'saml-apps', 'connectors',
  'admin-cert', 'auth', 'sod', 'risk', 'audit', 'reports',
];

const state = { me: null, current: 'home' };

window.LILG_NAV = navigate;

function buildShell() {
  const me = state.me;
  const isAdmin = ROLES_ADMIN.includes(me.employee?.role);
  const isSuper = me.employee?.role === 'SUPER_ADMIN';

  const primaryButtons = PRIMARY_NAV_ORDER.map((key) => {
    const r = ROUTES[key];
    if (r.admin && !isAdmin) return '';
    return `<button data-key="${key}">${esc(r.label)}</button>`;
  }).join('');

  const adminButton = isAdmin
    ? `<button data-key="admin-toggle">Admin</button>`
    : '';

  const subnavButtons = ADMIN_SUBNAV_ORDER.map((key) => {
    const r = ROUTES[key];
    if (!r) return '';
    if (r.super && !isSuper) return '';
    return `<button data-key="${key}">${esc(r.label)}</button>`;
  }).join('');

  const root = el(`
    <div class="shell">
      <header class="topnav">
        <div class="brand">
          <span class="brand-logo">L</span>
          <span>Lenskart IdP</span>
        </div>
        <nav class="primary-nav" id="primary-nav">
          ${primaryButtons}
          ${adminButton}
        </nav>
        <div class="topnav-actions">
          <div class="search-global">
            <input type="search" placeholder="Search users, apps…" id="global-search" />
          </div>
          <div class="profile-menu" id="profile-menu">
            <span class="avatar">${esc(initials(me.employee?.full_name || me.session?.email))}</span>
            <div>
              <div class="profile-name">${esc(me.employee?.full_name || me.session?.email || 'User')}</div>
              <div class="profile-role">${esc(me.employee?.role || 'USER')}</div>
            </div>
            <div class="profile-dropdown" id="profile-dropdown">
              <a href="#" data-key="settings">Account settings</a>
              ${isAdmin ? '<a href="#" data-key="audit">Audit logs</a>' : ''}
              ${me.capabilities?.metadataUrl ? `<a href="${esc(me.capabilities.metadataUrl)}" target="_blank">SAML metadata</a>` : ''}
              <div class="sep"></div>
              <button class="danger" id="logout-btn">Sign out</button>
            </div>
          </div>
        </div>
      </header>
      <nav class="subnav hidden" id="subnav">${subnavButtons}</nav>
      <main class="content" id="content"><div class="loading-row"><span class="spinner"></span></div></main>
    </div>
  `);

  // Primary nav click
  root.querySelector('#primary-nav').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-key]');
    if (!btn) return;
    const key = btn.dataset.key;
    if (key === 'admin-toggle') {
      navigate('dashboard');
    } else {
      navigate(key);
    }
  });

  // Subnav click
  root.querySelector('#subnav').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-key]');
    if (!btn) return;
    navigate(btn.dataset.key);
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
  dd.querySelectorAll('a[data-key]').forEach((a) => {
    a.addEventListener('click', (e) => { e.preventDefault(); navigate(a.dataset.key); });
  });
  root.querySelector('#logout-btn').addEventListener('click', async () => {
    try { await api.logout(); } catch {}
    location.href = '/login';
  });

  return root;
}

function applyActiveNav() {
  const route = ROUTES[state.current];
  if (!route) return;
  document.querySelectorAll('#primary-nav button').forEach((b) => {
    const k = b.dataset.key;
    if (k === 'admin-toggle') {
      b.classList.toggle('active', route.primary === 'admin');
    } else {
      b.classList.toggle('active', k === route.primary);
    }
  });
  const subnav = document.getElementById('subnav');
  if (route.primary === 'admin') {
    subnav.classList.remove('hidden');
    subnav.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', b.dataset.key === route.subnav);
    });
  } else {
    subnav.classList.add('hidden');
  }
}

async function navigate(key) {
  const me = state.me;
  const route = ROUTES[key];
  if (!route) return;
  if (route.admin && !ROLES_ADMIN.includes(me.employee?.role)) return;
  if (route.super && me.employee?.role !== 'SUPER_ADMIN') return;

  state.current = key;
  history.replaceState(null, '', key === 'home' ? '/' : `/?v=${key}`);
  applyActiveNav();

  const content = document.getElementById('content');
  if (route.end) {
    // end-user view; signature is (me, content) or (content)
    if (route.end.length >= 2) await route.end(me, content);
    else await route.end(content);
    return;
  }
  if (route.view) {
    if (route.view === viewSamlApps || route.view === viewSettings) {
      await route.view(me, content);
    } else {
      await route.view(content);
    }
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

  // Default landing
  const isAdmin = ROLES_ADMIN.includes(state.me.employee?.role);
  const params = new URLSearchParams(location.search);
  const initial = params.get('v') || 'home';
  // Translate legacy /admin-central
  if (path === '/admin-central') { if (!isAdmin) { location.href = '/'; return; } }

  state.current = ROUTES[initial] ? initial : 'home';
  root.replaceChildren(buildShell());
  navigate(state.current);
}

main();
