/* ============================================================
   Lenskart IdP Console — SPA entry point.
   Top nav (workspace) + admin sidebar (when in Admin).
   Layout: SailPoint top nav + miniOrange-style admin sidebar.
   ============================================================ */
import { api } from './api.js';
import { el, esc, initials, persistSearch, syncAppUrl, portalRoleOf, isPortalAdmin, isPortalSuperAdmin, hasPortalModule } from './ui.js';
import { icon } from './icons.js';
import { initTheme, mountThemeMenu, themeOptionsHtml, wireThemePicker } from './theme.js';
import {
  renderLogin, viewHome, viewMyAccess, viewRequestAccess, viewMyTasks, viewSettings, viewMyVault,
} from './views-end-user.js';
import { reportBrowserAppSignals } from './browser-discovery.js';
import { startSessionWatchdog } from './session-watchdog.js';
import {
  viewDashboard, viewSamlApps, viewIgaApps, viewUsers, viewAdmins,
  viewReviews, viewAccessRequests, viewSod, viewRisk, viewAuth, viewAudit, viewReports,
  viewReportsHub, viewGovReports, viewApplications,
} from './views-admin.js';
import {
  viewGroups, viewBulkUsers, viewSystemUsers, viewIdentityProfiles,
  viewMfaMethods, viewAdaptiveAuth, viewPasswordPolicies,
  viewDirectorySync,
  viewRoles, viewBirthright, viewEntitlementCatalog, viewAppAccessPolicy,
  viewPamResources, viewPamSessions, viewPamVault,
  viewWorkflowLibrary, viewNotifications,
  viewGeneralSettings, viewBranding, viewLicense, viewTickets, viewSystemHealth,
  viewAttendanceIga, viewRadiusVpn,
} from './views-stubs.js';

/* ----------------------------------------------------------------
   ROUTES — every navigable destination, indexed by key.
   key             → { primary, group?, label, admin?, super?, view }
   primary         workspace section (home/request/tasks/reviews/admin/settings)
   group           heading inside the admin sidebar (only when primary === 'admin')
   ---------------------------------------------------------------- */
const ROUTES = {
  /* ── Workspace (top primary nav) ── */
  home:     { primary: 'home',     label: 'Home',           icon: 'grid',         view: viewHome },
  request:  { primary: 'request',  label: 'Request Access', icon: 'catalog',      view: viewRequestAccess },
  tasks:    { primary: 'tasks',    label: 'Approvals',      icon: 'check',        view: viewMyTasks },
  myaccess: { primary: 'myaccess', label: 'My Access',      icon: 'key',          view: viewMyAccess },
  vault:    { primary: 'vault',    label: 'Vault',          icon: 'vault',        view: viewMyVault },

  /* ── Account ── */
  settings: { primary: 'settings', label: 'Security',       icon: 'shield',       view: viewSettings },

  /* ── Admin > Dashboard ── */
  dashboard: { primary: 'admin', group: 'Overview', label: 'Dashboard', icon: 'dashboard', admin: true, module: 'overview', view: viewDashboard },

  /* ── Admin > Identity ── */
  users:            { primary: 'admin', group: 'Identity', label: 'Users / Identities',  icon: 'user',         admin: true, module: 'identity_users', view: viewUsers },
  groups:           { primary: 'admin', group: 'Identity', label: 'Groups',              icon: 'users',        admin: true, module: 'identity_groups', view: viewGroups },
  bulkUsers:        { primary: 'admin', group: 'Identity', label: 'Bulk User Import',    icon: 'refresh',      admin: true, module: 'identity_users', view: viewBulkUsers },
  admins:           { primary: 'admin', group: 'Identity', label: 'Administrators',      icon: 'userShield',   admin: true, module: 'administrators', view: viewAdmins },
  identityProfiles: { primary: 'admin', group: 'Identity', label: 'Identity Profiles',   icon: 'identityCard', admin: true, module: 'identity_users', view: viewIdentityProfiles },
  /* systemUsers / PAM — not available yet (hidden) */

  /* ── Admin > Authentication ── */
  ssoConfig:          { primary: 'admin', group: 'Authentication', label: 'SSO Configuration',   icon: 'key',         admin: true, module: 'authentication', view: viewAuth },
  mfaMethods:         { primary: 'admin', group: 'Authentication', label: 'Strong Auth Methods', icon: 'fingerprint', admin: true, module: 'authentication', view: viewMfaMethods },
  adaptiveAuth:       { primary: 'admin', group: 'Authentication', label: 'Adaptive Auth',       icon: 'adaptive',    admin: true, module: 'authentication', view: viewAdaptiveAuth },
  passwordPolicies:   { primary: 'admin', group: 'Authentication', label: 'Password Policies',   icon: 'lock',        admin: true, module: 'authentication', view: viewPasswordPolicies },
  radiusVpn:          { primary: 'admin', group: 'Authentication', label: 'VPN / RADIUS',        icon: 'server',      admin: true, module: 'authentication', view: viewRadiusVpn },

  /* ── Admin > Applications ── */
  applications: { primary: 'admin', group: 'Applications', label: 'Applications', icon: 'catalog', admin: true, module: 'applications', view: viewApplications },

  /* ── Admin > Connections ── */
  directorySync: { primary: 'admin', group: 'Connections', label: 'Directory Sync', icon: 'refresh', admin: true, module: 'connections', view: viewDirectorySync },

  /* ── Admin > Access Model ── */
  roles:            { primary: 'admin', group: 'Access Model', label: 'Business Roles',            icon: 'tag',      admin: true, module: 'access_model', view: viewRoles },
  entitlementCatalog: { primary: 'admin', group: 'Access Model', label: 'Entitlements Catalog',    icon: 'list',     admin: true, module: 'access_model', view: viewEntitlementCatalog },
  birthright:       { primary: 'admin', group: 'Access Model', label: 'Birthright Rules',          icon: 'triangle', admin: true, module: 'access_model', view: viewBirthright },
  appAccessPolicy:  { primary: 'admin', group: 'Access Model', label: 'Application Access Policy', icon: 'key',      admin: true, module: 'access_model', view: viewAppAccessPolicy },

  /* Privileged Access — SUPER_ADMIN only (vault encrypts with SESSION_SECRET AES-GCM) */
  pamResources: { primary: 'admin', group: 'Privileged Access', label: 'Privileged Resources', icon: 'server',   admin: true, super: true, view: viewPamResources },
  pamSessions:  { primary: 'admin', group: 'Privileged Access', label: 'Privileged Sessions',  icon: 'activity', admin: true, super: true, view: viewPamSessions },
  pamVault:     { primary: 'admin', group: 'Privileged Access', label: 'Credential Vault',     icon: 'vault',    admin: true, super: true, view: viewPamVault },
  systemUsers:  { primary: 'admin', group: 'Privileged Access', label: 'System / Privileged',  icon: 'userCog',  admin: true, super: true, view: viewSystemUsers },

  /* ── Admin > Identity Governance ── */
  reviews: { primary: 'admin', group: 'Identity Governance', label: 'Certifications',        icon: 'certificate', admin: true, module: 'governance', view: viewReviews },
  accessRequests: { primary: 'admin', group: 'Identity Governance', label: 'Access Requests', icon: 'check', admin: true, module: 'governance', view: viewAccessRequests },
  sod:     { primary: 'admin', group: 'Identity Governance', label: 'Segregation of Duties', icon: 'split',       admin: true, module: 'governance', view: viewSod },
  risk:    { primary: 'admin', group: 'Identity Governance', label: 'Risk',                  icon: 'alert',       admin: true, module: 'governance', view: viewRisk },
  attendanceIga: { primary: 'admin', group: 'Identity Governance', label: 'Attendance IGA', icon: 'activity', admin: true, module: 'governance', view: viewAttendanceIga },

  /* ── Admin > Workflows & Automation ── */
  workflowLibrary: { primary: 'admin', group: 'Workflows', label: 'Workflows', icon: 'flow', admin: true, module: 'workflows', view: viewWorkflowLibrary },
  notifications:   { primary: 'admin', group: 'Workflows', label: 'Notifications', icon: 'bell', admin: true, module: 'workflows', view: viewNotifications },

  /* ── Admin > Reports ── */
  reportHub:   { primary: 'admin', group: 'Reports', label: 'Overview',            icon: 'dashboard',   admin: true, module: 'reports', view: viewReportsHub },
  govReports:  { primary: 'admin', group: 'Reports', label: 'Identity & Access',   icon: 'key',         admin: true, module: 'reports', view: viewGovReports },
  audit:       { primary: 'admin', group: 'Reports', label: 'Audit & SSO Reports', icon: 'list',        admin: true, module: 'reports', view: viewAudit },
  reports:     { primary: 'admin', group: 'Reports', label: 'Compliance Reports', icon: 'certificate', admin: true, module: 'reports', view: viewReports },

  /* ── Admin > Settings ── */
  generalSettings:  { primary: 'admin', group: 'Settings', label: 'General',         icon: 'cog',         admin: true, module: 'settings', view: viewGeneralSettings },
  branding:         { primary: 'admin', group: 'Settings', label: 'Branding & Login', icon: 'paint',       admin: true, module: 'settings', view: viewBranding },
  license:          { primary: 'admin', group: 'Settings', label: 'License',         icon: 'certificate', admin: true, module: 'administrators', view: viewLicense },
  tickets:          { primary: 'admin', group: 'Settings', label: 'Tickets',         icon: 'ticket',      admin: true, module: 'settings', view: viewTickets },
  systemHealth:     { primary: 'admin', group: 'Settings', label: 'System Health',   icon: 'pulse',       admin: true, module: 'settings', view: viewSystemHealth },
};

/* Order of groups in the admin sidebar */
const ADMIN_GROUPS = [
  'Overview',
  'Identity',
  'Authentication',
  'Applications',
  'Connections',
  'Access Model',
  'Privileged Access',
  'Identity Governance',
  'Workflows',
  'Reports',
  'Settings',
];

/* Order of items in the primary top nav */
const PRIMARY_NAV_ORDER = ['home', 'request', 'tasks', 'myaccess', 'vault'];

const APP_ROUTE_ALIASES = { 'iga-apps': 'catalog', 'saml-apps': 'saml', oidcApps: 'oidc' };
const ADMIN_SIDEBAR_ALIASES = { 'iga-apps': 'applications', 'saml-apps': 'applications', oidcApps: 'applications' };

const state = { me: null, current: 'home', appsTab: 'catalog', routeTab: null };
window.LILG_NAV = navigate;

/* ----------------------------------------------------------------
   SHELL
   ---------------------------------------------------------------- */
function buildShell() {
  const me = state.me;
  const isAdmin = isPortalAdmin(me);
  const isSuper = isPortalSuperAdmin(me);

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
    if (r.hidden) continue;
    if (r.super && !isSuper) continue;
    if (r.module && !hasPortalModule(me, r.module, 'read')) continue;
    if (!groupMap.has(r.group)) groupMap.set(r.group, []);
    groupMap.get(r.group).push({ key, ...r });
  }
  const sidebarHtml = `<div class="sidebar-toggle-btn"><button id="sidebar-toggle" title="Toggle sidebar" aria-label="Collapse sidebar">${icon('chevronLeft')}</button></div>` +
    ADMIN_GROUPS.map((group) => {
      const items = groupMap.get(group);
      if (!items) return '';
      return `<div class="nav-section">${esc(group)}</div>` +
        items.map((i) => `<button data-key="${esc(i.key)}" title="${esc(i.label)}"><span class="nav-icon">${icon(i.icon || 'grid')}</span><span class="label-text">${esc(i.label)}</span></button>`).join('');
    }).join('');

  const root = el(`
    <div class="app-root">
    <div class="shell">
      <header class="topnav">
        <button type="button" class="mobile-menu-btn" id="mobile-menu-btn" aria-label="Open menu" aria-expanded="false">
          <span class="i-wrap">${icon('menu')}</span>
        </button>
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
              <div class="profile-role">${esc(me.employee?.role || 'Employee')}${isPortalAdmin(me) ? ` · ${esc(portalRoleOf(me))}` : ''}</div>
            </div>
            <div class="profile-dropdown" id="profile-dropdown">
              <a href="#" data-key="settings">Security settings</a>
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
          <button data-key="vault"><span class="nav-icon">${icon('vault')}</span><span class="label-text">Vault</span></button>
          <button data-key="settings"><span class="nav-icon">${icon('shield')}</span><span class="label-text">Security</span></button>
        </aside>
        <aside class="admin-sidebar hidden" id="admin-sidebar">${sidebarHtml}</aside>
        <main class="content" id="content"><div class="loading-row"><span class="spinner"></span></div></main>
      </div>
    </div>
    <div class="mobile-backdrop" id="mobile-backdrop" aria-hidden="true"></div>
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

  if (collapseState && toggleBtn && adminSidebar && shellEl) {
    adminSidebar.classList.add('collapsed');
    shellEl.classList.add('sidebar-collapsed');
    toggleBtn.innerHTML = icon('chevronRight');
  }

  toggleBtn?.addEventListener('click', () => {
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

  wireMobileNav(root);

  return root;
}

function wireMobileNav(root) {
  const appRoot = root;
  const shellEl = root.querySelector('.shell');
  const menuBtn = root.querySelector('#mobile-menu-btn');
  const backdrop = root.querySelector('#mobile-backdrop');
  if (!shellEl || !menuBtn) return;

  const mq = window.matchMedia('(max-width: 900px)');

  function closeMobileNav() {
    appRoot.classList.remove('mobile-nav-open');
    shellEl.classList.remove('mobile-nav-open');
    menuBtn.setAttribute('aria-expanded', 'false');
    backdrop?.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('nav-locked');
  }

  function openMobileNav() {
    if (!mq.matches) return;
    appRoot.classList.add('mobile-nav-open');
    shellEl.classList.add('mobile-nav-open');
    menuBtn.setAttribute('aria-expanded', 'true');
    backdrop?.setAttribute('aria-hidden', 'false');
    document.body.classList.add('nav-locked');
  }

  menuBtn.addEventListener('click', () => {
    if (shellEl.classList.contains('mobile-nav-open')) closeMobileNav();
    else openMobileNav();
  });

  backdrop?.addEventListener('click', closeMobileNav);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && shellEl.classList.contains('mobile-nav-open')) closeMobileNav();
  });

  const onMqChange = (e) => { if (!e.matches) closeMobileNav(); };
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onMqChange);
  else if (typeof mq.addListener === 'function') mq.addListener(onMqChange);

  for (const sel of ['#admin-sidebar', '#user-sidebar', '#primary-nav']) {
    root.querySelector(sel)?.addEventListener('click', (e) => {
      if (e.target.closest('button[data-key]')) closeMobileNav();
    });
  }
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
  applications:    'catalog',
  settings:        'profile',
  home:            'all',
  audit:           'saml',
  govReports:      'inventory',
  radiusVpn:       'overview',
  directorySync:   'sources',
  workflowLibrary: 'definitions',
  groups:          'directory',
};

/** Old nav keys that now point at a single live page (bookmarks / deep links). */
const ROUTE_REDIRECTS = {
  loginCustomization: 'branding',
  connectors: 'directorySync',
  eventTriggers: 'workflowLibrary',
  appDiscovery: 'applications',
  ssoReports: 'audit',
};

/** Optional default tab when an old key redirects. */
const ROUTE_REDIRECT_TABS = {
  eventTriggers: 'triggers',
  appDiscovery: 'discovery',
  ssoReports: 'sso',
};

async function navigate(key, opts = {}) {
  const me = state.me;
  let explicitTab = 'tab' in opts;
  let tab = explicitTab ? (opts.tab || null) : null;

  if (ROUTE_REDIRECTS[key]) {
    if (!explicitTab && ROUTE_REDIRECT_TABS[key]) {
      tab = ROUTE_REDIRECT_TABS[key];
      explicitTab = true;
    }
    key = ROUTE_REDIRECTS[key];
  }

  if (APP_ROUTE_ALIASES[key]) {
    tab = tab || APP_ROUTE_ALIASES[key];
    key = 'applications';
    explicitTab = true;
  }

  const route = ROUTES[key];
  if (!route) return;
  if (route.admin && !isPortalAdmin(me)) return;
  if (route.super && !isPortalSuperAdmin(me)) return;
  if (route.hidden) return;
  if (route.module && !hasPortalModule(me, route.module, 'read')) return;

  state.current = key;

  if (key === 'applications') {
    state.appsTab = explicitTab ? (tab || 'catalog') : 'catalog';
    tab = state.appsTab;
  } else if (explicitTab) {
    state.routeTab = tab || null;
  } else if (ROUTE_DEFAULT_TABS[key]) {
    tab = ROUTE_DEFAULT_TABS[key];
    state.routeTab = tab;
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
  } else if (key === 'audit' || key === 'govReports' || key === 'radiusVpn' || key === 'workflowLibrary' || key === 'groups') {
    await route.view(content, viewTab);
  } else if (key === 'directorySync') {
    await route.view(content, viewTab, me);
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
  if (!root) return;

  const path = location.pathname.replace(/\/$/, '') || '/';

  try {
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
    startSessionWatchdog(state.me);
    await navigate(state.current, { tab: params.get('tab') });

    /* Background: portal browser signals for App Discovery (not HTTP disk cache) */
    reportBrowserAppSignals().catch(() => {});

    /* Background: populate task badge counts */
    api.igaMyTasks().then(r => {
      const cnt = (r?.data || r || []).length;
      const badge = document.getElementById('us-task-badge');
      const topBadge = document.querySelector('#primary-nav [data-key="tasks"] .badge-count');
      if (badge && cnt > 0) { badge.textContent = cnt; badge.classList.remove('hidden'); }
      if (topBadge && cnt > 0) { topBadge.textContent = cnt; }
    }).catch(() => {});
  } catch (err) {
    console.error('Portal startup failed:', err);
    root.innerHTML = `<div class="auth-panel" style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem">
      <div class="auth-card" style="max-width:480px">
        <h2>Something went wrong</h2>
        <p class="muted">The portal could not start. Try a hard refresh (Ctrl+Shift+R) or sign in again.</p>
        <div class="alert alert-error" style="margin-top:1rem;word-break:break-word">${esc(String(err?.message || err))}</div>
        <a href="/login" class="btn btn-primary btn-block" style="margin-top:1rem">Go to sign in</a>
      </div>
    </div>`;
  }
}

main();
