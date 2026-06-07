/* ============================================================
   Lenskart IdP Console — SPA entry point.
   Top nav (workspace) + admin sidebar (when in Admin).
   Layout: SailPoint top nav + miniOrange-style admin sidebar.
   ============================================================ */
import { api } from './api.js?v=2026-06-07-device-v2';
import { el, esc, initials, persistSearch, syncAppUrl } from './ui.js?v=2026-06-08';
import { icon } from './icons.js';
import { initTheme, mountThemeMenu, themeOptionsHtml, wireThemePicker } from './theme.js';
import {
  renderLogin, viewHome, viewMyAccess, viewRequestAccess, viewMyTasks, viewSettings,
} from './views-end-user.js?v=2026-06-08';
import {
  viewDashboard, viewSamlApps, viewIgaApps, viewConnectors, viewUsers, viewAdmins,
  viewReviews, viewSod, viewRisk, viewAuth, viewAudit, viewReports, viewApplications,
} from './views-admin.js?v=2026-06-08';
import {
  viewGroups, viewSystemUsers, viewIdentityProfiles,
  viewMfaMethods, viewAdaptiveAuth, viewPasswordPolicies, viewLoginCustomization,
  viewAppDiscovery,
  viewDirectorySync,
  viewRoles, viewBirthright, viewAppAccessPolicy,
  viewPamResources, viewPamSessions, viewPamVault,
  viewWorkflowLibrary, viewEventTriggers, viewNotifications,
  viewSsoReports,
  viewGeneralSettings, viewBranding, viewLicense, viewTickets, viewSystemHealth,
} from './views-stubs.js?v=2026-06-08';

const ROLES_ADMIN = ['ADMIN', 'SUPER_ADMIN'];

/* ----------------------------------------------------------------
   ROUTES — every navigable destination, indexed by key.
   key             → { primary, group?, label, admin?, super?, view }
   primary         workspace section (home/request/tasks/reviews/admin/settings)
   group           heading inside the admin sidebar (only when primary === 'admin')
   ---------------------------------------------------------------- */
const ROUTES = {
  /* ── Workspace (top primary nav) ── */
  home:     { primary: 'home',     label: 'Home',           icon: 'grid',         view: viewHome },
  request:  { primary: 'request',  label: 'Request Center', icon: 'catalog',      view: viewRequestAccess },
  tasks:    { primary: 'tasks',    label: 'Approvals',      icon: 'check',        view: viewMyTasks },
  myaccess: { primary: 'myaccess', label: 'My Access',      icon: 'key',          view: viewMyAccess },

  /* ── Account ── */
  settings: { primary: 'settings', label: 'Account',        icon: 'shield',       view: viewSettings },

  /* ── Admin > Dashboard ── */
  dashboard: { primary: 'admin', group: 'Overview', label: 'Dashboard', icon: 'dashboard', admin: true, view: viewDashboard },

  /* ── Admin > Identity ── */
  users:            { primary: 'admin', group: 'Identity', label: 'Users / Identities',  icon: 'users',        admin: true, view: viewUsers },
  groups:           { primary: 'admin', group: 'Identity', label: 'Groups',              icon: 'users',        admin: true, view: viewGroups },
  admins:           { primary: 'admin', group: 'Identity', label: 'Administrators',      icon: 'userShield',   super: true, view: viewAdmins },
  systemUsers:      { primary: 'admin', group: 'Identity', label: 'System / Privileged', icon: 'userCog',      admin: true, view: viewSystemUsers },
  identityProfiles: { primary: 'admin', group: 'Identity', label: 'Identity Profiles',   icon: 'identityCard', admin: true, view: viewIdentityProfiles },

  /* ── Admin > Authentication ── */
  ssoConfig:          { primary: 'admin', group: 'Authentication', label: 'SSO Configuration',   icon: 'key',         admin: true, view: viewAuth },
  mfaMethods:         { primary: 'admin', group: 'Authentication', label: 'Strong Auth Methods', icon: 'shieldCheck', admin: true, view: viewMfaMethods },
  adaptiveAuth:       { primary: 'admin', group: 'Authentication', label: 'Adaptive Auth',       icon: 'adaptive',    admin: true, view: viewAdaptiveAuth },
  passwordPolicies:   { primary: 'admin', group: 'Authentication', label: 'Password Policies',   icon: 'lock',        admin: true, view: viewPasswordPolicies },
  loginCustomization: { primary: 'admin', group: 'Authentication', label: 'Login Customization', icon: 'paint',       admin: true, view: viewLoginCustomization },

  /* ── Admin > Applications ── */
  applications: { primary: 'admin', group: 'Applications', label: 'Applications', icon: 'app', admin: true, view: viewApplications },
  appDiscovery: { primary: 'admin', group: 'Applications', label: 'App Discovery',       icon: 'search',  admin: true, view: viewAppDiscovery },

  /* ── Admin > Connections ── */
  connectors:    { primary: 'admin', group: 'Connections', label: 'Connectors / Sources', icon: 'plug',    admin: true, view: viewConnectors },
  directorySync: { primary: 'admin', group: 'Connections', label: 'Directory Sync',       icon: 'refresh', admin: true, view: viewDirectorySync },

  /* ── Admin > Access Model ── */
  roles:            { primary: 'admin', group: 'Access Model', label: 'Business Roles',           icon: 'tag',      admin: true, view: viewRoles },
  birthright:       { primary: 'admin', group: 'Access Model', label: 'Birthright Rules',         icon: 'triangle', admin: true, view: viewBirthright },
  appAccessPolicy:  { primary: 'admin', group: 'Access Model', label: 'Application Access Policy', icon: 'key',    admin: true, view: viewAppAccessPolicy },

  /* ── Admin > Privileged Access ── */
  pamResources: { primary: 'admin', group: 'Privileged Access', label: 'Privileged Resources', icon: 'server',   admin: true, view: viewPamResources },
  pamSessions:  { primary: 'admin', group: 'Privileged Access', label: 'Privileged Sessions',  icon: 'activity', admin: true, view: viewPamSessions },
  pamVault:     { primary: 'admin', group: 'Privileged Access', label: 'Credential Vault',     icon: 'vault',    admin: true, view: viewPamVault },

  /* ── Admin > Identity Governance ── */
  reviews: { primary: 'admin', group: 'Identity Governance', label: 'Certifications',        icon: 'certificate', admin: true, view: viewReviews },
  sod:     { primary: 'admin', group: 'Identity Governance', label: 'Segregation of Duties', icon: 'split',       admin: true, view: viewSod },
  risk:    { primary: 'admin', group: 'Identity Governance', label: 'Risk',                  icon: 'alert',       admin: true, view: viewRisk },

  /* ── Admin > Workflows & Automation ── */
  workflowLibrary: { primary: 'admin', group: 'Workflows', label: 'Workflow Library', icon: 'flow', admin: true, view: viewWorkflowLibrary },
  eventTriggers:   { primary: 'admin', group: 'Workflows', label: 'Event Triggers',   icon: 'bolt', admin: true, view: viewEventTriggers },
  notifications:   { primary: 'admin', group: 'Workflows', label: 'Notifications',    icon: 'bell', admin: true, view: viewNotifications },

  /* ── Admin > Reports ── */
  audit:      { primary: 'admin', group: 'Reports', label: 'Audit Log',          icon: 'list',        admin: true, view: viewAudit },
  ssoReports: { primary: 'admin', group: 'Reports', label: 'SSO Reports',        icon: 'chart',       admin: true, view: viewSsoReports },
  reports:    { primary: 'admin', group: 'Reports', label: 'Compliance Reports', icon: 'certificate', admin: true, view: viewReports },

  /* ── Admin > Settings ── */
  generalSettings:  { primary: 'admin', group: 'Settings', label: 'General',         icon: 'cog',         admin: true, view: viewGeneralSettings },
  branding:         { primary: 'admin', group: 'Settings', label: 'Branding',        icon: 'paint',       admin: true, view: viewBranding },
  license:          { primary: 'admin', group: 'Settings', label: 'License',         icon: 'certificate', super: true, view: viewLicense },
  tickets:          { primary: 'admin', group: 'Settings', label: 'Tickets',         icon: 'ticket',      admin: true, view: viewTickets },
  systemHealth:     { primary: 'admin', group: 'Settings', label: 'System Health',   icon: 'pulse',       admin: true, view: viewSystemHealth },
};

/* Order of groups in the admin sidebar + their group icon */
const ADMIN_GROUPS = [
  { name: 'Overview',            icon: 'dashboard' },
  { name: 'Identity',            icon: 'users' },
  { name: 'Authentication',      icon: 'shieldCheck' },
  { name: 'Applications',        icon: 'app' },
  { name: 'Connections',         icon: 'plug' },
  { name: 'Access Model',        icon: 'tag' },
  { name: 'Privileged Access',   icon: 'server' },
  { name: 'Identity Governance', icon: 'certificate' },
  { name: 'Workflows',           icon: 'flow' },
  { name: 'Reports',             icon: 'chart' },
  { name: 'Settings',            icon: 'cog' },
];
const ADMIN_GROUP_ORDER = ADMIN_GROUPS.map((g) => g.name);

/* Order of items in the primary top nav */
const PRIMARY_NAV_ORDER = ['home', 'request', 'tasks', 'myaccess'];

const APP_ROUTE_ALIASES = { 'iga-apps': 'catalog', 'saml-apps': 'saml', oidcApps: 'oidc' };
const ADMIN_SIDEBAR_ALIASES = { 'iga-apps': 'applications', 'saml-apps': 'applications', oidcApps: 'applications' };

const state = { me: null, current: 'home', appsTab: 'catalog', routeTab: null };
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

  const adminButton = isAdmin
    ? `<button data-key="dashboard" class="admin-pill"><span class="i-wrap">${icon('dashboard')}</span>Admin</button>`
    : '';

  /* Build admin sidebar grouped */
  const collapseState = localStorage.getItem('idp_sidebar_collapsed') === '1';
  const groupMap = new Map();
  for (const [key, r] of Object.entries(ROUTES)) {
    if (r.primary !== 'admin') continue;
    if (r.super && !isSuper) continue;
    if (!groupMap.has(r.group)) groupMap.set(r.group, []);
    groupMap.get(r.group).push({ key, ...r });
  }
  const sidebarHtml = `<div class="sidebar-toggle-btn"><button id="sidebar-toggle" title="Toggle sidebar" aria-label="Collapse sidebar">${icon('chevronLeft')}</button></div>` +
    ADMIN_GROUPS.map((g) => {
      const items = groupMap.get(g.name);
      if (!items) return '';
      return `<div class="nav-section"><span class="nav-section-icon">${icon(g.icon)}</span><span class="label-text">${esc(g.name)}</span></div>` +
        items.map((i) => `<button data-key="${esc(i.key)}" title="${esc(i.label)}"><span class="nav-icon">${icon(i.icon || 'grid')}</span><span class="label-text">${esc(i.label)}</span></button>`).join('');
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
          <div class="theme-picker" id="theme-picker">
            <button type="button" class="theme-picker-btn" id="theme-picker-btn" title="Appearance" aria-label="Choose theme" aria-haspopup="true">
              <span class="i-wrap">${icon('palette')}</span>
            </button>
            <div class="theme-picker-menu" id="theme-picker-menu" role="menu" aria-label="Theme options">
              <div class="theme-picker-heading">Theme</div>
              <div class="theme-picker-grid">${themeOptionsHtml()}</div>
            </div>
          </div>
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
          <button data-key="home"><span class="nav-icon">${icon('grid')}</span><span class="label-text">All Applications</span></button>
          <button data-key="request"><span class="nav-icon">${icon('catalog')}</span><span class="label-text">Request Access</span></button>
          <button data-key="tasks"><span class="nav-icon">${icon('check')}</span><span class="label-text">Approvals</span><span class="task-badge hidden" id="us-task-badge"></span></button>
          <button data-key="myaccess"><span class="nav-icon">${icon('key')}</span><span class="label-text">My Access</span></button>
          <button data-key="settings"><span class="nav-icon">${icon('shield')}</span><span class="label-text">Security</span></button>
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
    toggleBtn.innerHTML = icon('chevronRight');
  }

  toggleBtn.addEventListener('click', () => {
    const isCollapsed = adminSidebar.classList.toggle('collapsed');
    shellEl.classList.toggle('sidebar-collapsed', isCollapsed);
    toggleBtn.innerHTML = isCollapsed ? icon('chevronRight') : icon('chevronLeft');
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

  mountThemeMenu(root);

  /* Keep the global search text across page refreshes */
  persistSearch(root.querySelector('#global-search'), 'global');

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
      const activeKey = ADMIN_SIDEBAR_ALIASES[state.current] || state.current;
      b.classList.toggle('active', b.dataset.key === activeKey);
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
const ROUTE_DEFAULT_TABS = {
  applications:  'catalog',
  settings:      'profile',
  home:          'all',
  audit:         'saml',
  directorySync: 'sources',
};

async function navigate(key, opts = {}) {
  const me = state.me;
  const explicitTab = 'tab' in opts;
  let tab = explicitTab ? (opts.tab || null) : null;

  if (APP_ROUTE_ALIASES[key]) {
    tab = tab || APP_ROUTE_ALIASES[key];
    key = 'applications';
  }

  const route = ROUTES[key];
  if (!route) return;
  if (route.admin && !ROLES_ADMIN.includes(me.employee?.role)) return;
  if (route.super && me.employee?.role !== 'SUPER_ADMIN') return;

  state.current = key;

  if (key === 'applications') {
    state.appsTab = explicitTab ? (tab || 'catalog') : 'catalog';
    tab = state.appsTab;
  } else if (explicitTab) {
    state.routeTab = tab || null;
  } else {
    state.routeTab = null;
    tab = null;
  }

  syncAppUrl(key, tab, ROUTE_DEFAULT_TABS[key]);
  applyActiveNav();

  const content = document.getElementById('content');
  const viewTab = tab || ROUTE_DEFAULT_TABS[key] || null;

  const needsMe = new Set(['home', 'settings', 'applications']);
  if (needsMe.has(key)) {
    if (key === 'applications') await route.view(me, content, state.appsTab);
    else if (key === 'settings') await route.view(me, content, viewTab);
    else if (key === 'home') await route.view(me, content, viewTab);
    else await route.view(me, content);
  } else if (key === 'audit') {
    await route.view(content, viewTab);
  } else if (key === 'directorySync') {
    await route.view(content, viewTab);
  } else {
    await route.view(content);
  }
}

/* ----------------------------------------------------------------
   ENTRY
   ---------------------------------------------------------------- */
async function main() {
  initTheme();
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
  const initialParam = params.get('v') || 'home';
  if (APP_ROUTE_ALIASES[initialParam]) {
    state.current = 'applications';
    state.appsTab = params.get('tab') || APP_ROUTE_ALIASES[initialParam];
  } else {
    state.current = ROUTES[initialParam] ? initialParam : 'home';
    if (state.current === 'applications') {
      state.appsTab = params.get('tab') || 'catalog';
    }
  }

  root.replaceChildren(buildShell());
  navigate(state.current, { tab: params.get('tab') });

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
