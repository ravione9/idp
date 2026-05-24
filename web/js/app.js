/* ============================================================
   Lenskart IdP Console — SPA entry point.
   Top nav (workspace) + admin sidebar (when in Admin).
   Layout: SailPoint top nav + miniOrange-style admin sidebar.
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
import {
  viewGroups, viewSystemUsers, viewIdentityProfiles,
  viewMfaMethods, viewAdaptiveAuth, viewPasswordPolicies, viewLoginCustomization,
  viewOidcApps, viewAppDiscovery,
  viewDirectorySync,
  viewRoles, viewBirthright,
  viewPamResources, viewPamSessions, viewPamVault,
  viewWorkflowLibrary, viewEventTriggers, viewNotifications,
  viewSsoReports,
  viewGeneralSettings, viewBranding, viewLicense, viewTickets, viewSystemHealth,
} from './views-stubs.js';

const ROLES_ADMIN = ['ADMIN', 'SUPER_ADMIN'];

/* ----------------------------------------------------------------
   ROUTES — every navigable destination, indexed by key.
   key             → { primary, group?, label, admin?, super?, view }
   primary         workspace section (home/request/tasks/reviews/admin/settings)
   group           heading inside the admin sidebar (only when primary === 'admin')
   ---------------------------------------------------------------- */
const ROUTES = {
  /* ── Workspace (top primary nav) ── */
  home:     { primary: 'home',     label: 'Home',           view: viewHome },
  request:  { primary: 'request',  label: 'Request Center', view: viewRequestAccess },
  tasks:    { primary: 'tasks',    label: 'Approvals',      view: viewMyTasks },
  myaccess: { primary: 'myaccess', label: 'My Access',      view: viewMyAccess },

  /* ── Account ── */
  settings: { primary: 'settings', label: 'Account', view: viewSettings },

  /* ── Admin > Dashboard ── */
  dashboard: { primary: 'admin', group: 'Overview', label: 'Dashboard', admin: true, view: viewDashboard },

  /* ── Admin > Identity ── */
  users:            { primary: 'admin', group: 'Identity', label: 'Users / Identities',     admin: true, view: viewUsers },
  groups:           { primary: 'admin', group: 'Identity', label: 'Groups',                 admin: true, view: viewGroups },
  admins:           { primary: 'admin', group: 'Identity', label: 'Administrators',         super: true, view: viewAdmins },
  systemUsers:      { primary: 'admin', group: 'Identity', label: 'System / Privileged',    admin: true, view: viewSystemUsers },
  identityProfiles: { primary: 'admin', group: 'Identity', label: 'Identity Profiles',      admin: true, view: viewIdentityProfiles },

  /* ── Admin > Authentication ── */
  ssoConfig:          { primary: 'admin', group: 'Authentication', label: 'SSO Configuration',   admin: true, view: viewAuth },
  mfaMethods:         { primary: 'admin', group: 'Authentication', label: 'Strong Auth Methods', admin: true, view: viewMfaMethods },
  adaptiveAuth:       { primary: 'admin', group: 'Authentication', label: 'Adaptive Auth',       admin: true, view: viewAdaptiveAuth },
  passwordPolicies:   { primary: 'admin', group: 'Authentication', label: 'Password Policies',   admin: true, view: viewPasswordPolicies },
  loginCustomization: { primary: 'admin', group: 'Authentication', label: 'Login Customization', admin: true, view: viewLoginCustomization },

  /* ── Admin > Applications ── */
  'iga-apps':   { primary: 'admin', group: 'Applications', label: 'Application Catalog', admin: true, view: viewIgaApps },
  'saml-apps':  { primary: 'admin', group: 'Applications', label: 'SAML Applications',   admin: true, view: viewSamlApps },
  oidcApps:     { primary: 'admin', group: 'Applications', label: 'OIDC / OAuth',        admin: true, view: viewOidcApps },
  appDiscovery: { primary: 'admin', group: 'Applications', label: 'App Discovery',       admin: true, view: viewAppDiscovery },

  /* ── Admin > Connections ── */
  connectors:    { primary: 'admin', group: 'Connections', label: 'Connectors / Sources', admin: true, view: viewConnectors },
  directorySync: { primary: 'admin', group: 'Connections', label: 'Directory Sync',       admin: true, view: viewDirectorySync },

  /* ── Admin > Access Model ── */
  roles:        { primary: 'admin', group: 'Access Model', label: 'Business Roles',  admin: true, view: viewRoles },
  birthright:   { primary: 'admin', group: 'Access Model', label: 'Birthright Rules', admin: true, view: viewBirthright },

  /* ── Admin > Privileged Access ── */
  pamResources: { primary: 'admin', group: 'Privileged Access', label: 'Privileged Resources', admin: true, view: viewPamResources },
  pamSessions:  { primary: 'admin', group: 'Privileged Access', label: 'Privileged Sessions',  admin: true, view: viewPamSessions },
  pamVault:     { primary: 'admin', group: 'Privileged Access', label: 'Credential Vault',     admin: true, view: viewPamVault },

  /* ── Admin > Identity Governance ── */
  reviews: { primary: 'admin', group: 'Identity Governance', label: 'Certifications',           admin: true, view: viewReviews },
  sod:     { primary: 'admin', group: 'Identity Governance', label: 'Segregation of Duties',    admin: true, view: viewSod },
  risk:    { primary: 'admin', group: 'Identity Governance', label: 'Risk',                     admin: true, view: viewRisk },

  /* ── Admin > Workflows & Automation ── */
  workflowLibrary: { primary: 'admin', group: 'Workflows', label: 'Workflow Library', admin: true, view: viewWorkflowLibrary },
  eventTriggers:   { primary: 'admin', group: 'Workflows', label: 'Event Triggers',   admin: true, view: viewEventTriggers },
  notifications:   { primary: 'admin', group: 'Workflows', label: 'Notifications',    admin: true, view: viewNotifications },

  /* ── Admin > Reports ── */
  audit:      { primary: 'admin', group: 'Reports', label: 'Audit Log',          admin: true, view: viewAudit },
  ssoReports: { primary: 'admin', group: 'Reports', label: 'SSO Reports',        admin: true, view: viewSsoReports },
  reports:    { primary: 'admin', group: 'Reports', label: 'Compliance Reports', admin: true, view: viewReports },

  /* ── Admin > Settings ── */
  generalSettings:  { primary: 'admin', group: 'Settings', label: 'General',         admin: true, view: viewGeneralSettings },
  branding:         { primary: 'admin', group: 'Settings', label: 'Branding',        admin: true, view: viewBranding },
  license:          { primary: 'admin', group: 'Settings', label: 'License',         super: true, view: viewLicense },
  tickets:          { primary: 'admin', group: 'Settings', label: 'Tickets',         admin: true, view: viewTickets },
  systemHealth:     { primary: 'admin', group: 'Settings', label: 'System Health',   admin: true, view: viewSystemHealth },
};

/* Order of groups in the admin sidebar */
const ADMIN_GROUP_ORDER = [
  'Overview', 'Identity', 'Authentication', 'Applications', 'Connections',
  'Access Model', 'Privileged Access', 'Identity Governance', 'Workflows',
  'Reports', 'Settings',
];

/* Order of items in the primary top nav */
const PRIMARY_NAV_ORDER = ['home', 'request', 'tasks', 'myaccess'];

const state = { me: null, current: 'home' };
window.LILG_NAV = navigate;

/* ----------------------------------------------------------------
   SHELL
   ---------------------------------------------------------------- */
function buildShell() {
  const me = state.me;
  const isAdmin = ROLES_ADMIN.includes(me.employee?.role);
  const isSuper = me.employee?.role === 'SUPER_ADMIN';

  const primaryButtons = PRIMARY_NAV_ORDER.map((key) => {
    const r = ROUTES[key];
    if (r.admin && !isAdmin) return '';
    return `<button data-key="${key}" class="user-nav-btn">${esc(r.label)}</button>`;
  }).join('');

  const adminButton = isAdmin ? `<button data-key="dashboard">Admin</button>` : '';

  /* Build admin sidebar grouped */
  const collapseState = localStorage.getItem('idp_sidebar_collapsed') === '1';
  const groups = new Map();
  for (const [key, r] of Object.entries(ROUTES)) {
    if (r.primary !== 'admin') continue;
    if (r.super && !isSuper) continue;
    if (!groups.has(r.group)) groups.set(r.group, []);
    groups.get(r.group).push({ key, ...r });
  }
  const sidebarHtml = `<div class="sidebar-toggle-btn"><button id="sidebar-toggle" title="Toggle sidebar">◀</button></div>` +
    ADMIN_GROUP_ORDER.map((g) => {
      const items = groups.get(g);
      if (!items) return '';
      return `<div class="nav-section"><span class="label-text">${esc(g)}</span></div>` +
        items.map((i) => `<button data-key="${esc(i.key)}"><span class="label-text">${esc(i.label)}</span></button>`).join('');
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
      <div class="admin-body">
        <aside class="user-sidebar hidden" id="user-sidebar">
          <div class="user-sidebar-header">
            <span>My Portal</span>
          </div>
          <button data-key="home"><span class="nav-icon">🏠</span><span class="label-text">All Applications</span></button>
          <button data-key="request"><span class="nav-icon">📋</span><span class="label-text">Request Access</span></button>
          <button data-key="tasks"><span class="nav-icon">✅</span><span class="label-text">Approvals</span><span class="task-badge hidden" id="us-task-badge"></span></button>
          <button data-key="myaccess"><span class="nav-icon">🔑</span><span class="label-text">My Access</span></button>
          <button data-key="settings"><span class="nav-icon">🛡️</span><span class="label-text">Security</span></button>
        </aside>
        <aside class="admin-sidebar hidden" id="admin-sidebar">${sidebarHtml}</aside>
        <main class="content" id="content"><div class="loading-row"><span class="spinner"></span></div></main>
      </div>
    </div>
  `);

  /* Top nav click */
  root.querySelector('#primary-nav').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-key]');
    if (btn) navigate(btn.dataset.key);
  });

  /* Sidebar click */
  root.querySelector('#admin-sidebar').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-key]');
    if (btn) navigate(btn.dataset.key);
  });

  /* User sidebar click */
  root.querySelector('#user-sidebar').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-key]');
    if (btn) navigate(btn.dataset.key);
  });

  /* Admin sidebar collapse toggle */
  const toggleBtn = root.querySelector('#sidebar-toggle');
  const adminSidebar = root.querySelector('#admin-sidebar');
  const shellEl = root.querySelector('.shell');

  if (collapseState) {
    adminSidebar.classList.add('collapsed');
    shellEl.classList.add('sidebar-collapsed');
    toggleBtn.textContent = '▶';
  }

  toggleBtn.addEventListener('click', () => {
    const isCollapsed = adminSidebar.classList.toggle('collapsed');
    shellEl.classList.toggle('sidebar-collapsed', isCollapsed);
    toggleBtn.textContent = isCollapsed ? '▶' : '◀';
    localStorage.setItem('idp_sidebar_collapsed', isCollapsed ? '1' : '0');
  });

  /* Profile dropdown */
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

/* ----------------------------------------------------------------
   ACTIVE NAV STATE
   ---------------------------------------------------------------- */
function applyActiveNav() {
  const route = ROUTES[state.current];
  if (!route) return;

  /* Top nav */
  document.querySelectorAll('#primary-nav button').forEach((b) => {
    const k = b.dataset.key;
    /* "Admin" pseudo-button has key 'dashboard' so it lights up for any admin page */
    if (k === 'dashboard') {
      b.classList.toggle('active', route.primary === 'admin');
    } else {
      b.classList.toggle('active', k === state.current);
    }
  });

  /* Sidebar visibility — admin vs user mode */
  const shell = document.querySelector('.shell');
  const sidebar = document.getElementById('admin-sidebar');
  const userSidebar = document.getElementById('user-sidebar');
  if (route.primary === 'admin') {
    shell.classList.remove('user-mode');
    shell.classList.add('admin-mode');
    sidebar.classList.remove('hidden');
    if (userSidebar) userSidebar.classList.add('hidden');
    sidebar.querySelectorAll('button[data-key]').forEach((b) => {
      b.classList.toggle('active', b.dataset.key === state.current);
    });
  } else {
    shell.classList.remove('admin-mode');
    shell.classList.add('user-mode');
    sidebar.classList.add('hidden');
    if (userSidebar) {
      userSidebar.classList.remove('hidden');
      userSidebar.querySelectorAll('button[data-key]').forEach((b) => {
        b.classList.toggle('active', b.dataset.key === state.current);
      });
    }
  }
}

/* ----------------------------------------------------------------
   ROUTER
   ---------------------------------------------------------------- */
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

  /* Views with a (me, content) signature; everything else is (content). */
  const needsMe = new Set(['home', 'settings', 'saml-apps']);
  if (needsMe.has(key)) {
    await route.view(me, content);
  } else {
    await route.view(content);
  }
}

/* ----------------------------------------------------------------
   ENTRY
   ---------------------------------------------------------------- */
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

  const params = new URLSearchParams(location.search);
  const initial = params.get('v') || 'home';
  state.current = ROUTES[initial] ? initial : 'home';

  root.replaceChildren(buildShell());
  navigate(state.current);

  /* Background: populate task badge counts */
  api.igaMyTasks().then(r => {
    const cnt = (r?.data || r || []).length;
    const badge = document.getElementById('us-task-badge');
    const topBadge = document.querySelector('#primary-nav [data-key="tasks"] .badge-count');
    if (badge && cnt > 0) { badge.textContent = cnt; badge.classList.remove('hidden'); }
    if (topBadge && cnt > 0) { topBadge.textContent = cnt; }
  }).catch(() => {});
}

main();
