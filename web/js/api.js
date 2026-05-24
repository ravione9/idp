/* API client — small wrapper around fetch with credential cookies and JSON. */
export const api = {
  async fetch(path, options = {}) {
    const res = await fetch(path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const ct = res.headers.get('content-type') || '';
    const body = ct.includes('json') ? await res.json() : await res.text();
    if (!res.ok) {
      // Prefer body.message (used by connector test + most IGA endpoints),
      // then body.error (used by validation errors), then HTTP status text.
      const err = new Error((body && (body.message || body.error)) || res.statusText);
      err.status = res.status;
      err.body   = body;
      throw err;
    }
    return body;
  },
};

const f = api.fetch;
Object.assign(api, {
  me:               () => f('/api/me'),
  apps:             () => f('/api/apps'),
  diagz:            () => f('/diagz'),
  dashboard:        () => f('/api/admin/dashboard'),
  dashboardSeries:  () => f('/api/admin/dashboard/timeseries'),
  sessionsInsight:  () => f('/api/admin/dashboard/sessions-insight'),
  listUsers:        (q = '', state = '') =>
    f(`/api/admin/users?q=${encodeURIComponent(q)}&state=${encodeURIComponent(state)}&limit=200`),
  listLocalAdmins:  () => f('/api/admin/local-users'),
  createLocalAdmin: (data) => f('/api/admin/local-users', { method: 'POST', body: JSON.stringify(data) }),
  bootstrapAdmin:   (data) => f('/api/admin/local-users/bootstrap', { method: 'POST', body: JSON.stringify(data) }),
  adminStatus:      () => f('/api/admin/local-users/status'),
  deactivateAdmin:  (id) => f(`/api/admin/local-users/${id}`, { method: 'DELETE' }),
  idpStatus:        () => f('/api/admin/saml-apps/status'),
  listSamlApps:     () => f('/api/admin/saml-apps'),
  createSamlApp:    (data) => f('/api/admin/saml-apps', { method: 'POST', body: JSON.stringify(data) }),
  deactivateSamlApp:(id) => f(`/api/admin/saml-apps/${id}`, { method: 'DELETE' }),
  updateSamlApp:    (id, data) => f(`/api/admin/saml-apps/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  activateSamlApp:  (id) => f(`/api/admin/saml-apps/${id}/activate`, { method: 'PUT' }),
  samlAudit:        () => f('/api/admin/audit/saml'),
  systemAudit:      () => f('/api/admin/audit/system'),

  localLogin:       (email, password) =>
    f('/auth/local/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  localLoginMfa:    (challengeId, code) =>
    f('/auth/local/login/mfa-verify', { method: 'POST', body: JSON.stringify({ challengeId, code }) }),
  logout:           () => f('/auth/logout', { method: 'POST' }),
  changePassword:   (currentPassword, newPassword) =>
    f('/api/me/password', { method: 'PUT', body: JSON.stringify({ currentPassword, newPassword }) }),
  listSessions:     () => f('/api/me/sessions'),
  revokeSession:    (id) => f(`/api/me/sessions/${id}`, { method: 'DELETE' }),
  mfaStatus:        () => f('/api/me/mfa'),
  mfaEnroll:        () => f('/api/me/mfa/enroll', { method: 'POST' }),
  mfaConfirm:       (code) => f('/api/me/mfa/confirm', { method: 'POST', body: JSON.stringify({ code }) }),
  mfaDisable:       () => f('/api/me/mfa/disable', { method: 'POST' }),
  mfaRegenCodes:    () => f('/api/me/mfa/regenerate-codes', { method: 'POST' }),

  igaApps:          () => f('/api/iga/applications'),
  createIgaApp:     (data) => f('/api/iga/applications', { method: 'POST', body: JSON.stringify(data) }),
  updateIgaApp:     (id, data) => f(`/api/iga/applications/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteIgaApp:     (id) => f(`/api/iga/applications/${id}`, { method: 'DELETE' }),
  igaConnectors:    () => f('/api/iga/connectors'),
  igaEntitlements:  (appId) => f(`/api/iga/entitlements${appId ? `?appId=${appId}` : ''}`),
  igaMyAccess:      () => f('/api/iga/entitlements/me'),
  igaAccessReqs:    (scope = 'mine') => f(`/api/iga/access-requests?scope=${scope}`),
  igaMyTasks:       () => f('/api/iga/access-requests?scope=tasks'),
  igaReviews:       () => f('/api/iga/access-reviews'),
  igaMyReviews:     () => f('/api/iga/access-reviews/me'),
  igaSodPolicies:   () => f('/api/iga/sod-policies'),
  igaSodViolations: (status = 'OPEN') => f(`/api/iga/sod-violations?status=${status}`),
  igaRisk:          () => f('/api/iga/risk/dashboard'),
  igaReports:       () => f('/api/iga/reports'),

  // Connector CRUD
  getConnector:      (id) => f(`/api/iga/connectors/${id}`),
  createConnector:   (data) => f('/api/iga/connectors', { method: 'POST', body: JSON.stringify(data) }),
  updateConnector:   (id, data) => f(`/api/iga/connectors/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteConnector:   (id) => f(`/api/iga/connectors/${id}`, { method: 'DELETE' }),
  testConnector:     (id) => f(`/api/iga/connectors/${id}/test`, { method: 'POST' }),
  getConnectorRuns:  (id, limit = 10) => f(`/api/iga/connectors/${id}/runs?limit=${limit}`),
});

Object.assign(api, {
  // Groups
  listGroups:       () => f('/api/admin/groups'),
  getGroup:         (id) => f(`/api/admin/groups/${id}`),
  createGroup:      (data) => f('/api/admin/groups', { method: 'POST', body: JSON.stringify(data) }),
  updateGroup:      (id, data) => f(`/api/admin/groups/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteGroup:      (id) => f(`/api/admin/groups/${id}`, { method: 'DELETE' }),
  addGroupMember:   (id, empId) => f(`/api/admin/groups/${id}/members`, { method: 'POST', body: JSON.stringify({ empId }) }),
  removeGroupMember:(id, empId) => f(`/api/admin/groups/${id}/members/${empId}`, { method: 'DELETE' }),

  // Identity Profiles
  listIdentityProfiles:  () => f('/api/admin/identity-profiles'),
  createIdentityProfile: (data) => f('/api/admin/identity-profiles', { method: 'POST', body: JSON.stringify(data) }),
  updateIdentityProfile: (id, data) => f(`/api/admin/identity-profiles/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteIdentityProfile: (id) => f(`/api/admin/identity-profiles/${id}`, { method: 'DELETE' }),

  // Adaptive Auth
  listAdaptivePolicies:  () => f('/api/admin/adaptive-auth'),
  createAdaptivePolicy:  (data) => f('/api/admin/adaptive-auth', { method: 'POST', body: JSON.stringify(data) }),
  updateAdaptivePolicy:  (id, data) => f(`/api/admin/adaptive-auth/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAdaptivePolicy:  (id) => f(`/api/admin/adaptive-auth/${id}`, { method: 'DELETE' }),
  evaluateAdaptive:      (ctx) => f('/api/admin/adaptive-auth/evaluate', { method: 'POST', body: JSON.stringify(ctx) }),

  // Password Policies
  listPasswordPolicies:  () => f('/api/admin/password-policies'),
  createPasswordPolicy:  (data) => f('/api/admin/password-policies', { method: 'POST', body: JSON.stringify(data) }),
  updatePasswordPolicy:  (id, data) => f(`/api/admin/password-policies/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deletePasswordPolicy:  (id) => f(`/api/admin/password-policies/${id}`, { method: 'DELETE' }),

  // Branding
  getBranding:    () => f('/api/admin/branding'),
  saveBranding:   (data) => f('/api/admin/branding', { method: 'PUT', body: JSON.stringify(data) }),

  // General Settings
  getGeneralSettings:  () => f('/api/admin/general-settings'),
  saveGeneralSettings: (data) => f('/api/admin/general-settings', { method: 'PUT', body: JSON.stringify(data) }),

  // Portal SSL
  getPortalSsl:        () => f('/api/admin/portal-ssl'),
  uploadPortalSsl:     (data) => f('/api/admin/portal-ssl', { method: 'POST', body: JSON.stringify(data) }),
  deletePortalSsl:     () => f('/api/admin/portal-ssl', { method: 'DELETE' }),
  savePortalConnection:(data) => f('/api/admin/portal-ssl/connection', { method: 'PUT', body: JSON.stringify(data) }),

  // OIDC Clients
  listOidcClients:    () => f('/api/admin/oidc-clients'),
  createOidcClient:   (data) => f('/api/admin/oidc-clients', { method: 'POST', body: JSON.stringify(data) }),
  updateOidcClient:   (id, data) => f(`/api/admin/oidc-clients/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteOidcClient:   (id) => f(`/api/admin/oidc-clients/${id}`, { method: 'DELETE' }),
  rotateOidcSecret:   (id) => f(`/api/admin/oidc-clients/${id}/rotate-secret`, { method: 'POST' }),

  // PAM
  listPamResources:    () => f('/api/admin/pam/resources'),
  createPamResource:   (data) => f('/api/admin/pam/resources', { method: 'POST', body: JSON.stringify(data) }),
  updatePamResource:   (id, data) => f(`/api/admin/pam/resources/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deletePamResource:   (id) => f(`/api/admin/pam/resources/${id}`, { method: 'DELETE' }),
  listPamSessions:     () => f('/api/admin/pam/sessions'),
  terminatePamSession: (id) => f(`/api/admin/pam/sessions/${id}/terminate`, { method: 'POST' }),
  listVaultEntries:    () => f('/api/admin/pam/vault'),
  createVaultEntry:    (data) => f('/api/admin/pam/vault', { method: 'POST', body: JSON.stringify(data) }),
  deleteVaultEntry:    (id) => f(`/api/admin/pam/vault/${id}`, { method: 'DELETE' }),
  checkoutVaultEntry:  (id) => f(`/api/admin/pam/vault/${id}/checkout`, { method: 'POST' }),
  listSystemUsers:     () => f('/api/admin/pam/system-users'),
  createSystemUser:    (data) => f('/api/admin/pam/system-users', { method: 'POST', body: JSON.stringify(data) }),
  deleteSystemUser:    (id) => f(`/api/admin/pam/system-users/${id}`, { method: 'DELETE' }),

  // Workflows
  listWorkflows:       () => f('/api/admin/workflows/definitions'),
  createWorkflow:      (data) => f('/api/admin/workflows/definitions', { method: 'POST', body: JSON.stringify(data) }),
  updateWorkflow:      (id, data) => f(`/api/admin/workflows/definitions/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteWorkflow:      (id) => f(`/api/admin/workflows/definitions/${id}`, { method: 'DELETE' }),
  listEventTriggers:   () => f('/api/admin/workflows/triggers'),
  createEventTrigger:  (data) => f('/api/admin/workflows/triggers', { method: 'POST', body: JSON.stringify(data) }),
  updateEventTrigger:  (id, data) => f(`/api/admin/workflows/triggers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteEventTrigger:  (id) => f(`/api/admin/workflows/triggers/${id}`, { method: 'DELETE' }),

  // Tickets
  listTickets:    (status = '', cat = '') => f(`/api/admin/tickets?status=${encodeURIComponent(status)}&category=${encodeURIComponent(cat)}`),
  createTicket:   (data) => f('/api/admin/tickets', { method: 'POST', body: JSON.stringify(data) }),
  updateTicket:   (id, data) => f(`/api/admin/tickets/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  // System Health
  systemHealth:  () => f('/api/admin/system-health'),

  // SSO Reports
  ssoLoginSummary:  () => f('/api/admin/sso-reports/login-summary'),
  ssoFailedLogins:  () => f('/api/admin/sso-reports/failed-logins'),
  ssoAppAdoption:   () => f('/api/admin/sso-reports/app-adoption'),
  ssoDormantUsers:  () => f('/api/admin/sso-reports/dormant-users'),

  // Business Roles
  listBusinessRoles:     () => f('/api/admin/business-roles'),
  createBusinessRole:    (data) => f('/api/admin/business-roles', { method: 'POST', body: JSON.stringify(data) }),
  updateBusinessRole:    (id, data) => f(`/api/admin/business-roles/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteBusinessRole:    (id) => f(`/api/admin/business-roles/${id}`, { method: 'DELETE' }),
  getRoleEntitlements:   (id) => f(`/api/admin/business-roles/${id}/entitlements`),
  addRoleEntitlement:    (id, entId) => f(`/api/admin/business-roles/${id}/entitlements`, { method: 'POST', body: JSON.stringify({ entitlementId: entId }) }),
  removeRoleEntitlement: (id, entId) => f(`/api/admin/business-roles/${id}/entitlements/${entId}`, { method: 'DELETE' }),

  // Birthright
  listBirthrightRules: () => f('/api/admin/birthright'),
  birthrightDryRun:    () => f('/api/admin/birthright/dry-run'),
  runBirthright:       () => f('/api/admin/birthright/run', { method: 'POST' }),

  // Notifications
  listNotifications:     (status='', ch='', limit=50, offset=0) => f(`/api/admin/notifications?status=${status}&channel=${ch}&limit=${limit}&offset=${offset}`),
  notificationStats:     () => f('/api/admin/notifications/stats'),
  sendTestNotification:  (data) => f('/api/admin/notifications/test', { method: 'POST', body: JSON.stringify(data) }),
  dispatchNotifications: () => f('/api/admin/notifications/dispatch-pending', { method: 'POST' }),

  // User lifecycle
  suspendUser:   (empId, reason) => f(`/api/admin/users/${empId}/suspend`, { method: 'POST', body: JSON.stringify({ reason }) }),
  unsuspendUser: (empId, reason) => f(`/api/admin/users/${empId}/unsuspend`, { method: 'POST', body: JSON.stringify({ reason }) }),
  terminateUser: (empId, reason) => f(`/api/admin/users/${empId}/terminate`, { method: 'POST', body: JSON.stringify({ reason }) }),
  userLifecycle: (empId) => f(`/api/admin/users/${empId}/lifecycle`),

  // Unified directory — hybrid identity
  listUsersUnified: (q = '', state = '', source = '', limit = 100, offset = 0) =>
    f(`/api/admin/users?q=${encodeURIComponent(q)}&state=${encodeURIComponent(state)}&source=${encodeURIComponent(source)}&limit=${limit}&offset=${offset}`),
  getUserProfile:      (empId) => f(`/api/admin/users/${empId}`),
  createLocalUser:     (data) => f('/api/admin/users/local', { method: 'POST', body: JSON.stringify(data) }),
  adminResetPassword:  (empId, newPassword, notifyUser = false) =>
    f(`/api/admin/users/${empId}/reset-password`, { method: 'POST', body: JSON.stringify({ newPassword, notifyUser }) }),
  linkIdentity:        (empId, data) => f(`/api/admin/users/${empId}/link-identity`, { method: 'POST', body: JSON.stringify(data) }),
  unlinkIdentity:      (empId, linkId) => f(`/api/admin/users/${empId}/identity-links/${linkId}`, { method: 'DELETE' }),

  // Access requests
  igaSubmitRequest:  (data) => f('/api/iga/access-requests', { method: 'POST', body: JSON.stringify(data) }),
  igaRequestDecision: (id, decision, comment) => f(`/api/iga/access-requests/${id}/decision`, { method: 'POST', body: JSON.stringify({ decision, comment }) }),

  // Access reviews CRUD
  createAccessReview: (data) => f('/api/iga/access-reviews', { method: 'POST', body: JSON.stringify(data) }),
  igaReviewItems:     (campaignId) => f(`/api/iga/access-reviews/${campaignId}/items`),
  submitReviewDecision: (campaignId, itemId, decision, comment) => f(`/api/iga/access-reviews/${campaignId}/items/${itemId}/decision`, { method: 'POST', body: JSON.stringify({ decision, comment }) }),

  // SoD Policy CRUD
  createSodPolicy: (data) => f('/api/iga/sod-policies', { method: 'POST', body: JSON.stringify(data) }),
  updateSodPolicy: (id, data) => f(`/api/iga/sod-policies/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteSodPolicy: (id) => f(`/api/iga/sod-policies/${id}`, { method: 'DELETE' }),

  // SoD violation remediation
  igaRemediateSod: (id) => f(`/api/iga/sod-violations/${id}/remediate`, { method: 'POST' }),
});
