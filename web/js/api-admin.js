/* Admin API helpers — loaded only after authentication (see gated /js/api-admin.js). */
import { api } from './api.js';

const f = api.fetch;
Object.assign(api, {
  dashboard:        () => f('/api/admin/dashboard'),
  dashboardSeries:  () => f('/api/admin/dashboard/timeseries'),
  sessionsInsight:  () => f('/api/admin/dashboard/sessions-insight'),
  listUsers:        (q = '', state = '') =>
    f(`/api/admin/users?q=${encodeURIComponent(q)}&state=${encodeURIComponent(state)}&limit=200`),
  listLocalAdmins:  () => f('/api/admin/local-users'),
  createLocalAdmin: (data) => f('/api/admin/local-users', { method: 'POST', body: JSON.stringify(data) }),
  adminStatus:      () => f('/api/admin/local-users/status'),
  deactivateAdmin:  (id) => f(`/api/admin/local-users/${id}`, { method: 'DELETE' }),
  listPortalRoles:  () => f('/api/admin/portal-roles'),
  listPortalModules:() => f('/api/admin/portal-roles/modules'),
  createPortalRole: (data) => f('/api/admin/portal-roles', { method: 'POST', body: JSON.stringify(data) }),
  updatePortalRole: (id, data) => f(`/api/admin/portal-roles/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deletePortalRole: (id) => f(`/api/admin/portal-roles/${id}`, { method: 'DELETE' }),
  idpStatus:        () => f('/api/admin/saml-apps/status'),
  listSamlApps:     () => f('/api/admin/saml-apps'),
  samlAttributeFields: () => f('/api/admin/saml-apps/attribute-fields'),
  createSamlApp:    (data) => f('/api/admin/saml-apps', { method: 'POST', body: JSON.stringify(data) }),
  parseSamlMetadata:(metadata) => f('/api/admin/saml-apps/parse-metadata', { method: 'POST', body: JSON.stringify({ metadata }) }),
  deactivateSamlApp:(id) => f(`/api/admin/saml-apps/${id}`, { method: 'DELETE' }),
  updateSamlApp:    (id, data) => f(`/api/admin/saml-apps/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  activateSamlApp:  (id) => f(`/api/admin/saml-apps/${id}/activate`, { method: 'PUT' }),
  enableSamlRequestAccess: (id) => f(`/api/admin/saml-apps/${id}/enable-request-access`, { method: 'POST' }),
  enableAllSamlRequestAccess: () => f('/api/admin/saml-apps/enable-request-access-all', { method: 'POST' }),
  samlAudit:        (params = {}) => f(`/api/admin/audit/saml?${new URLSearchParams(params)}`),
  systemAudit:      (params = {}) => f(`/api/admin/audit/system?${new URLSearchParams(params)}`),
  authAttemptsAudit:(params = {}) => f(`/api/admin/audit/auth-attempts?${new URLSearchParams(params)}`),
  sessionsAudit:    (params = {}) => f(`/api/admin/audit/sessions?${new URLSearchParams(params)}`),
  revokeAuditSession: (id) => f(`/api/admin/audit/sessions/${encodeURIComponent(id)}/revoke`, { method: 'POST' }),
  auditIntegrity:   (limit = 1000) => f(`/api/admin/audit/integrity?limit=${limit}`),
  auditSummary:     (params = {}) => f(`/api/admin/audit/summary?${new URLSearchParams(params)}`),
  auditExportUrl:   (kind, params = {}) => {
    const q = new URLSearchParams({ ...params, export: 'csv' });
    return `/api/admin/audit/${kind}?${q}`;
  },
  discoveryStats:   () => f('/api/admin/app-discovery/stats'),
  listDiscoveredApps: (params = {}) => f(`/api/admin/app-discovery?${new URLSearchParams(params)}`),
  createDiscoveredApp: (data) => f('/api/admin/app-discovery', { method: 'POST', body: JSON.stringify(data) }),
  updateDiscoveredApp: (id, data) => f(`/api/admin/app-discovery/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  scanDiscoveredApps: () => f('/api/admin/app-discovery/scan', { method: 'POST' }),
  promoteDiscoveredApp: (id) => f(`/api/admin/app-discovery/${id}/promote`, { method: 'POST' }),
  deleteDiscoveredApp: (id) => f(`/api/admin/app-discovery/${id}`, { method: 'DELETE' }),
  igaApps:          () => f('/api/iga/applications'),
  createIgaApp:     (data) => f('/api/iga/applications', { method: 'POST', body: JSON.stringify(data) }),
  updateIgaApp:     (id, data) => f(`/api/iga/applications/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteIgaApp:     (id) => f(`/api/iga/applications/${id}`, { method: 'DELETE' }),
  igaConnectors:    () => f('/api/iga/connectors'),
  harvestEntitlements: (id) => f(`/api/iga/connectors/${id}/harvest-entitlements`, { method: 'POST' }),
  harvestAllEntitlements: () => f('/api/iga/connectors/harvest-entitlements-all', { method: 'POST' }),
  igaReviews:       () => f('/api/iga/access-reviews'),
  igaSodPolicies:   () => f('/api/iga/sod-policies'),
  igaSodViolations: (status = 'OPEN') => f(`/api/iga/sod-violations?status=${status}`),
  igaRisk:          () => f('/api/iga/risk/dashboard'),
  igaReports:       () => f('/api/iga/reports'),

  // Connector CRUD,
  getConnector:      (id) => f(`/api/iga/connectors/${id}`),
  createConnector:   (data) => f('/api/iga/connectors', { method: 'POST', body: JSON.stringify(data) }),
  updateConnector:   (id, data) => f(`/api/iga/connectors/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteConnector:   (id) => f(`/api/iga/connectors/${id}`, { method: 'DELETE' }),
  testConnector:     (id) => f(`/api/iga/connectors/${id}/test`, { method: 'POST' }),
  getConnectorRuns:  (id, limit = 10) => f(`/api/iga/connectors/${id}/runs?limit=${limit}`),
  listGroups:       () => f('/api/admin/groups'),
  syncDirectoryGroups: () => f('/api/admin/groups/sync', { method: 'POST' }),
  getGroup:         (id) => f(`/api/admin/groups/${id}`),
  createGroup:      (data) => f('/api/admin/groups', { method: 'POST', body: JSON.stringify(data) }),
  updateGroup:      (id, data) => f(`/api/admin/groups/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteGroup:      (id) => f(`/api/admin/groups/${id}`, { method: 'DELETE' }),
  addGroupMember:   (id, empId) => f(`/api/admin/groups/${id}/members`, { method: 'POST', body: JSON.stringify({ empId }) }),
  addGroupMembersBulk: (id, members, action = 'add') => f(`/api/admin/groups/${id}/members/bulk`, {
    method: 'POST', body: JSON.stringify({ members, action }),
  }),
  groupMembersCsvBulk: (id, csvText, action = 'add') => f(`/api/admin/groups/${id}/members/bulk`, {
    method: 'POST', body: JSON.stringify({ csvText, action }),
  }),
  groupMembersCsvTemplateUrl: () => '/api/admin/groups/members/csv-template',
  removeGroupMember:(id, empId) => f(`/api/admin/groups/${id}/members/${encodeURIComponent(empId)}`, { method: 'DELETE' }),

  // Identity Profiles,
  listIdentityProfiles:  () => f('/api/admin/identity-profiles'),
  createIdentityProfile: (data) => f('/api/admin/identity-profiles', { method: 'POST', body: JSON.stringify(data) }),
  updateIdentityProfile: (id, data) => f(`/api/admin/identity-profiles/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteIdentityProfile: (id) => f(`/api/admin/identity-profiles/${id}`, { method: 'DELETE' }),

  // Adaptive Auth,
  listAdaptivePolicies:  () => f('/api/admin/adaptive-auth'),
  createAdaptivePolicy:  (data) => f('/api/admin/adaptive-auth', { method: 'POST', body: JSON.stringify(data) }),
  updateAdaptivePolicy:  (id, data) => f(`/api/admin/adaptive-auth/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAdaptivePolicy:  (id) => f(`/api/admin/adaptive-auth/${id}`, { method: 'DELETE' }),
  evaluateAdaptive:      (ctx) => f('/api/admin/adaptive-auth/evaluate', { method: 'POST', body: JSON.stringify(ctx) }),

  // Password Policies,
  listPasswordPolicies:  () => f('/api/admin/password-policies'),
  createPasswordPolicy:  (data) => f('/api/admin/password-policies', { method: 'POST', body: JSON.stringify(data) }),
  updatePasswordPolicy:  (id, data) => f(`/api/admin/password-policies/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deletePasswordPolicy:  (id) => f(`/api/admin/password-policies/${id}`, { method: 'DELETE' }),

  // Branding,
  getBranding:    () => f('/api/admin/branding'),
  saveBranding:   (data) => f('/api/admin/branding', { method: 'PUT', body: JSON.stringify(data) }),

  // General Settings,
  getGeneralSettings:  () => f('/api/admin/general-settings'),
  saveGeneralSettings: (data) => f('/api/admin/general-settings', { method: 'PUT', body: JSON.stringify(data) }),
  getGoogleOidcSettings: () => f('/api/admin/general-settings/google-oidc'),
  saveGoogleOidcSettings: (data) => f('/api/admin/general-settings/google-oidc', { method: 'PUT', body: JSON.stringify(data) }),

  // Portal SSL,
  getPortalSsl:        () => f('/api/admin/portal-ssl'),
  uploadPortalSsl:     (data) => f('/api/admin/portal-ssl', { method: 'POST', body: JSON.stringify(data) }),
  deletePortalSsl:     () => f('/api/admin/portal-ssl', { method: 'DELETE' }),
  savePortalConnection:(data) => f('/api/admin/portal-ssl/connection', { method: 'PUT', body: JSON.stringify(data) }),

  // OIDC Clients,
  listOidcClients:    () => f('/api/admin/oidc-clients'),
  getOidcClient:      (id) => f(`/api/admin/oidc-clients/${id}`),
  createOidcClient:   (data) => f('/api/admin/oidc-clients', { method: 'POST', body: JSON.stringify(data) }),
  updateOidcClient:   (id, data) => f(`/api/admin/oidc-clients/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteOidcClient:   (id) => f(`/api/admin/oidc-clients/${id}`, { method: 'DELETE' }),
  rotateOidcSecret:   (id) => f(`/api/admin/oidc-clients/${id}/rotate-secret`, { method: 'POST' }),

  // PAM,
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

  // Workflows,
  listWorkflows:       () => f('/api/admin/workflows/definitions'),
  createWorkflow:      (data) => f('/api/admin/workflows/definitions', { method: 'POST', body: JSON.stringify(data) }),
  updateWorkflow:      (id, data) => f(`/api/admin/workflows/definitions/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteWorkflow:      (id) => f(`/api/admin/workflows/definitions/${id}`, { method: 'DELETE' }),
  listWorkflowRuns:    (limit = 50) => f(`/api/admin/workflows/runs?limit=${limit}`),
  listEventTriggers:   () => f('/api/admin/workflows/triggers'),
  createEventTrigger:  (data) => f('/api/admin/workflows/triggers', { method: 'POST', body: JSON.stringify(data) }),
  updateEventTrigger:  (id, data) => f(`/api/admin/workflows/triggers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteEventTrigger:  (id) => f(`/api/admin/workflows/triggers/${id}`, { method: 'DELETE' }),

  // Attendance IGA,
  attendanceIgaDashboard: (configId = 1) => f(`/api/admin/attendance-iga/dashboard?configId=${configId}`),
  attendanceIgaConfigs:   () => f('/api/admin/attendance-iga/configs'),
  createAttendanceIgaConfig: (data) => f('/api/admin/attendance-iga/configs', { method: 'POST', body: JSON.stringify(data) }),
  deleteAttendanceIgaConfig: (id) => f(`/api/admin/attendance-iga/configs/${id}`, { method: 'DELETE' }),
  attendanceIgaConfig:    (configId = 1) => f(`/api/admin/attendance-iga/config?configId=${configId}`),
  attendanceIgaSftpPreview: (configId = 1) => f(`/api/admin/attendance-iga/sftp/preview?configId=${configId}`),
  attendanceIgaApiPreview: (offset = 0, configId = 1) => f(`/api/admin/attendance-iga/api/preview?offset=${offset}&configId=${configId}`),
  attendanceIgaApiTest:       (data = {}) => f('/api/admin/attendance-iga/api/test', { method: 'POST', body: JSON.stringify(data) }),
  updateAttendanceIgaConfig: (data, configId = 1) => f(`/api/admin/attendance-iga/config?configId=${configId}`, { method: 'PUT', body: JSON.stringify(data) }),
  attendanceIgaRules:     (configId = 1) => f(`/api/admin/attendance-iga/rules?configId=${configId}`),
  updateAttendanceIgaRule: (id, data) => f(`/api/admin/attendance-iga/rules/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  attendanceIgaExclusions: (configId = 1) => f(`/api/admin/attendance-iga/exclusions?configId=${configId}`),
  createAttendanceIgaExclusion: (data) => f('/api/admin/attendance-iga/exclusions', { method: 'POST', body: JSON.stringify(data) }),
  deleteAttendanceIgaExclusion: (id) => f(`/api/admin/attendance-iga/exclusions/${id}`, { method: 'DELETE' }),
  attendanceIgaImports:   (limit = 20, configId = 1) => f(`/api/admin/attendance-iga/imports?limit=${limit}&configId=${configId}`),
  runAttendanceIga:       (data) => f('/api/admin/attendance-iga/run', { method: 'POST', body: JSON.stringify(data) }),
  attendanceIgaApprovals: (status = 'PENDING') => f(`/api/admin/attendance-iga/approvals?status=${encodeURIComponent(status)}`),
  attendanceIgaApprovalDecision: (id, data) => f(`/api/admin/attendance-iga/approvals/${id}/decision`, { method: 'POST', body: JSON.stringify(data) }),
  attendanceIgaExecutions: (params = {}) => {
    const q = new URLSearchParams();
    q.set('configId', String(params.configId ?? 1));
    q.set('limit', String(params.limit ?? 100));
    if (params.q) q.set('q', params.q);
    if (params.status) q.set('status', params.status);
    if (params.rule) q.set('rule', params.rule);
    if (params.rolledBack != null && params.rolledBack !== '') q.set('rolledBack', String(params.rolledBack));
    if (params.action) q.set('action', params.action);
    return f(`/api/admin/attendance-iga/executions?${q}`);
  },
  rollbackAttendanceIgaExecution: (id) => f(`/api/admin/attendance-iga/executions/${id}/rollback`, { method: 'POST' }),
  bulkRollbackAttendanceIgaExecutions: (ids, configId = 1) =>
    f('/api/admin/attendance-iga/executions/bulk-rollback', {
      method: 'POST',
      body: JSON.stringify({ ids, configId }),
    }),
  attendanceIgaRollbacks: () => f('/api/admin/attendance-iga/rollbacks'),

  // Tickets,
  listTickets:    (status = '', cat = '') => f(`/api/admin/tickets?status=${encodeURIComponent(status)}&category=${encodeURIComponent(cat)}`),
  createTicket:   (data) => f('/api/admin/tickets', { method: 'POST', body: JSON.stringify(data) }),
  updateTicket:   (id, data) => f(`/api/admin/tickets/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  // System Health,
  systemHealth:  () => f('/api/admin/system-health'),

  // SSO Reports,
  ssoLoginSummary:  (params = {}) => f(`/api/admin/sso-reports/login-summary?${new URLSearchParams(params)}`),
  ssoFailedLogins:  (params = {}) => f(`/api/admin/sso-reports/failed-logins?${new URLSearchParams(params)}`),
  ssoAppAdoption:   (params = {}) => f(`/api/admin/sso-reports/app-adoption?${new URLSearchParams(params)}`),
  ssoDormantUsers:  (params = {}) => f(`/api/admin/sso-reports/dormant-users?${new URLSearchParams(params)}`),
  createComplianceReport: (data) => f('/api/iga/reports', { method: 'POST', body: JSON.stringify(data) }),
  getComplianceReport: (id) => f(`/api/iga/reports/${id}`),
  complianceReportExportUrl: (id) => `/api/iga/reports/${id}?export=json`,

  // Enterprise Reports Hub,
  reportsOverview:       (params = {}) => f(`/api/admin/reports/overview?${new URLSearchParams(params)}`),
  reportAccessInventory: (params = {}) => f(`/api/admin/reports/access-inventory?${new URLSearchParams(params)}`),
  reportMfaCoverage:     (params = {}) => f(`/api/admin/reports/mfa-coverage?${new URLSearchParams(params)}`),
  reportLifecycle:       (params = {}) => f(`/api/admin/reports/lifecycle?${new URLSearchParams(params)}`),
  reportAccessRequests:  (params = {}) => f(`/api/admin/reports/access-requests?${new URLSearchParams(params)}`),
  reportCertifications:  (params = {}) => f(`/api/admin/reports/certifications?${new URLSearchParams(params)}`),
  reportSod:             (params = {}) => f(`/api/admin/reports/sod?${new URLSearchParams(params)}`),
  reportAppAccessChanges:(params = {}) => f(`/api/admin/reports/app-access-changes?${new URLSearchParams(params)}`),
  reportExportUrl:       (kind, params = {}) => {
    const q = new URLSearchParams({ ...params, export: 'csv' });
    return `/api/admin/reports/${kind}?${q}`;
  },

  // VPN / RADIUS,
  radiusOverview:     () => f('/api/admin/radius/overview'),
  radiusClients:      () => f('/api/admin/radius/clients'),
  createRadiusClient: (data) => f('/api/admin/radius/clients', { method: 'POST', body: JSON.stringify(data) }),
  updateRadiusClient: (id, data) => f(`/api/admin/radius/clients/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteRadiusClient: (id) => f(`/api/admin/radius/clients/${id}`, { method: 'DELETE' }),
  revealRadiusSecret: (id) => f(`/api/admin/radius/clients/${id}/reveal-secret`, { method: 'POST' }),
  radiusPolicies:     () => f('/api/admin/radius/policies'),
  createRadiusPolicy: (data) => f('/api/admin/radius/policies', { method: 'POST', body: JSON.stringify(data) }),
  updateRadiusPolicy: (id, data) => f(`/api/admin/radius/policies/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteRadiusPolicy: (id) => f(`/api/admin/radius/policies/${id}`, { method: 'DELETE' }),
  vpnProfiles:        () => f('/api/admin/radius/vpn-profiles'),
  createVpnProfile:   (data) => f('/api/admin/radius/vpn-profiles', { method: 'POST', body: JSON.stringify(data) }),
  updateVpnProfile:   (id, data) => f(`/api/admin/radius/vpn-profiles/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteVpnProfile:   (id) => f(`/api/admin/radius/vpn-profiles/${id}`, { method: 'DELETE' }),
  radiusLogs:         (params = {}) => f(`/api/admin/radius/logs?${new URLSearchParams(params)}`),
  radiusTestAuth:     (data) => f('/api/admin/radius/test-auth', { method: 'POST', body: JSON.stringify(data) }),

  // Business Roles,
  listBusinessRoles:     () => f('/api/admin/business-roles'),
  createBusinessRole:    (data) => f('/api/admin/business-roles', { method: 'POST', body: JSON.stringify(data) }),
  updateBusinessRole:    (id, data) => f(`/api/admin/business-roles/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteBusinessRole:    (id) => f(`/api/admin/business-roles/${id}`, { method: 'DELETE' }),
  getRoleEntitlements:   (id) => f(`/api/admin/business-roles/${id}/entitlements`),
  addRoleEntitlement:    (id, entId) => f(`/api/admin/business-roles/${id}/entitlements`, { method: 'POST', body: JSON.stringify({ entitlementId: entId }) }),
  removeRoleEntitlement: (id, entId) => f(`/api/admin/business-roles/${id}/entitlements/${entId}`, { method: 'DELETE' }),

  // Birthright,
  listBirthrightRules: () => f('/api/admin/birthright'),
  createBirthrightRule:(data) => f('/api/admin/birthright', { method: 'POST', body: JSON.stringify(data) }),
  updateBirthrightRule:(id, data) => f(`/api/admin/birthright/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteBirthrightRule:(id) => f(`/api/admin/birthright/${id}`, { method: 'DELETE' }),
  birthrightDryRun:    () => f('/api/admin/birthright/dry-run'),
  runBirthright:       () => f('/api/admin/birthright/run', { method: 'POST' }),

  // Application Access Policy,
  appAccessSummary:     () => f('/api/admin/app-access-policy/summary'),
  listAppAccessApps:    () => f('/api/admin/app-access-policy/applications'),
  updateAppIpPolicy:    (appId, allowedCidrs) =>
    f(`/api/admin/app-access-policy/applications/${encodeURIComponent(appId)}/ip-policy`, {
      method: 'PUT',
      body: JSON.stringify({ allowedCidrs }),
    }),
  listTagGroups:        (activeOnly = true) =>
    f(`/api/admin/app-access-policy/tag-groups${activeOnly ? '' : '?activeOnly=0'}`),
  getTagGroup:          (id) => f(`/api/admin/app-access-policy/tag-groups/${id}`),
  createTagGroup:       (data) => f('/api/admin/app-access-policy/tag-groups', { method: 'POST', body: JSON.stringify(data) }),
  updateTagGroup:       (id, data) => f(`/api/admin/app-access-policy/tag-groups/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteTagGroup:       (id) => f(`/api/admin/app-access-policy/tag-groups/${id}`, { method: 'DELETE' }),
  addTagGroupMember:    (id, empId) => f(`/api/admin/app-access-policy/tag-groups/${id}/members`, { method: 'POST', body: JSON.stringify({ empId }) }),
  removeTagGroupMember: (id, empId) => f(`/api/admin/app-access-policy/tag-groups/${id}/members/${empId}`, { method: 'DELETE' }),
  listAppAssignments:   (appId = '') => f(`/api/admin/app-access-policy/assignments${appId ? `?appId=${encodeURIComponent(appId)}` : ''}`),
  createAppAssignment:  (data) => f('/api/admin/app-access-policy/assignments', { method: 'POST', body: JSON.stringify(data) }),
  updateAppAssignment:  (id, data) => f(`/api/admin/app-access-policy/assignments/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  revokeAppAssignment:  (id) => f(`/api/admin/app-access-policy/assignments/${id}`, { method: 'DELETE' }),
  listAppAccessWorkflows: (appId = '') => f(`/api/admin/app-access-policy/workflows${appId ? `?appId=${encodeURIComponent(appId)}` : ''}`),
  createAppAccessWorkflow: (data) => f('/api/admin/app-access-policy/workflows', { method: 'POST', body: JSON.stringify(data) }),
  updateAppAccessWorkflow: (id, data) => f(`/api/admin/app-access-policy/workflows/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAppAccessWorkflow: (id) => f(`/api/admin/app-access-policy/workflows/${id}`, { method: 'DELETE' }),
  listAppAccessAudit:   (appId = '', limit = 100) =>
    f(`/api/admin/app-access-policy/audit?limit=${limit}${appId ? `&appId=${encodeURIComponent(appId)}` : ''}`),

  // Notifications,
  listNotifications:     (status='', ch='', limit=50, offset=0) => f(`/api/admin/notifications?status=${status}&channel=${ch}&limit=${limit}&offset=${offset}`),
  notificationStats:     () => f('/api/admin/notifications/stats'),
  sendTestNotification:  (data) => f('/api/admin/notifications/test', { method: 'POST', body: JSON.stringify(data) }),
  dispatchNotifications: () => f('/api/admin/notifications/dispatch-pending', { method: 'POST' }),

  // User lifecycle,
  suspendUser:   (empId, reason) => f(`/api/admin/users/${empId}/suspend`, { method: 'POST', body: JSON.stringify({ reason }) }),
  unsuspendUser: (empId, reason) => f(`/api/admin/users/${empId}/unsuspend`, { method: 'POST', body: JSON.stringify({ reason }) }),
  terminateUser: (empId, reason) => f(`/api/admin/users/${empId}/terminate`, { method: 'POST', body: JSON.stringify({ reason }) }),
  userLifecycle: (empId) => f(`/api/admin/users/${empId}/lifecycle`),

  // Unified directory — hybrid identity,
  listUsersUnified: (q = '', state = '', source = '', limit = 100, offset = 0, includeInactive = false, filters = {}) => {
    const p = new URLSearchParams({
      q, state, source, limit: String(limit), offset: String(offset),
      includeInactive: includeInactive ? '1' : '0',
    });
    if (filters.department) p.set('department', filters.department);
    if (filters.manager) p.set('manager', filters.manager);
    if (filters.location) p.set('location', filters.location);
    if (filters.employeeType) p.set('employeeType', filters.employeeType);
    if (filters.employeeId) p.set('employeeId', filters.employeeId);
    return f(`/api/admin/users?${p}`);
  },
  getUserProfile:      (empId) => f(`/api/admin/users/${encodeURIComponent(empId)}`),
  updateUserProfile:   (empId, data) => f(`/api/admin/users/${encodeURIComponent(empId)}/profile`, { method: 'PUT', body: JSON.stringify(data) }),
  createLocalUser:     (data) => f('/api/admin/users/local', { method: 'POST', body: JSON.stringify(data) }),
  exportUsers:         (source = '', state = '') =>
    f(`/api/admin/users/export?source=${encodeURIComponent(source)}&state=${encodeURIComponent(state)}`),
  bulkUserAction:      (data) => f('/api/admin/users/bulk-action', { method: 'POST', body: JSON.stringify(data) }),
  adminMfaStatus:      (empId) => f(`/api/admin/users/${empId}/mfa`),
  adminMfaEnroll:      (empId) => f(`/api/admin/users/${empId}/mfa/enroll`, { method: 'POST' }),
  adminMfaConfirm:     (empId, code) => f(`/api/admin/users/${empId}/mfa/confirm`, { method: 'POST', body: JSON.stringify({ code }) }),
  adminMfaDisable:     (empId) => f(`/api/admin/users/${empId}/mfa/disable`, { method: 'POST' }),
  adminMfaRegenCodes:  (empId) => f(`/api/admin/users/${empId}/mfa/regenerate-codes`, { method: 'POST' }),
  adminMfaEnforce:     (empId, enforce) => f(`/api/admin/users/${empId}/mfa/enforce`, { method: 'POST', body: JSON.stringify({ enforce }) }),
  getMfaPolicy:        () => f('/api/admin/users/mfa-policy'),
  getMfaDeliveryStatus: () => f('/api/admin/users/mfa-delivery-status'),
  saveMfaDelivery:     (data) => f('/api/admin/users/mfa-delivery', { method: 'PUT', body: JSON.stringify(data) }),
  updateMfaPolicy:     (data) => f('/api/admin/users/mfa-policy', { method: 'POST', body: JSON.stringify(data) }),
  listMfaGroupPolicies: () => f('/api/admin/users/mfa-group-policies'),
  createMfaGroupPolicy: (data) => f('/api/admin/users/mfa-group-policies', { method: 'POST', body: JSON.stringify(data) }),
  updateMfaGroupPolicy: (id, data) => f(`/api/admin/users/mfa-group-policies/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteMfaGroupPolicy: (id) => f(`/api/admin/users/mfa-group-policies/${id}`, { method: 'DELETE' }),
  adminResetPassword:  (empId, newPassword, notifyUser = false) =>
    f(`/api/admin/users/${empId}/reset-password`, { method: 'POST', body: JSON.stringify({ newPassword, notifyUser }) }),
  updateUserRole:      (empId, role) => f(`/api/admin/users/${empId}/role`, { method: 'PATCH', body: JSON.stringify({ role }) }),
  linkIdentity:        (empId, data) => f(`/api/admin/users/${empId}/link-identity`, { method: 'POST', body: JSON.stringify(data) }),
  unlinkIdentity:      (empId, linkId) => f(`/api/admin/users/${empId}/identity-links/${linkId}`, { method: 'DELETE' }),

  // Bulk user import (chunked — up to 100k rows total),
  bulkUsersBatch: (rows, mode = 'upsert') =>
    f('/api/admin/bulk-users/batch', { method: 'POST', body: JSON.stringify({ rows, mode }) }),
  bulkUsersValidate: (rows) =>
    f('/api/admin/bulk-users/validate', { method: 'POST', body: JSON.stringify({ rows }) }),
  bulkUsersTemplateUrl: (format = 'csv') => `/api/admin/bulk-users/template?format=${format}`,

  // Google directory attribute map + sync,
  getGoogleAttrMaps: () => f('/api/admin/directory/google/attr-maps'),
  saveGoogleAttrMaps: (maps) => f('/api/admin/directory/google/attr-maps', { method: 'PUT', body: JSON.stringify({ maps }) }),
  getGoogleSyncSettings: () => f('/api/admin/directory/google/sync-settings'),
  saveGoogleSyncSettings: (data) => f('/api/admin/directory/google/sync-settings', { method: 'PUT', body: JSON.stringify(data) }),
  googleSyncNow: () => f('/api/admin/directory/google/sync-now', { method: 'POST' }),
  googleFullSync: () => f('/api/admin/directory/google/full-sync', { method: 'POST' }),
  googleSyncLogs: (limit = 50) => f(`/api/admin/directory/google/logs?limit=${limit}`),

  // Access requests,
  igaFulfillRequest: (id) =>
    f(`/api/iga/access-requests/${encodeURIComponent(id)}/fulfill`, { method: 'POST' }),

  // Access reviews CRUD,
  createAccessReview: (data) => f('/api/iga/access-reviews', { method: 'POST', body: JSON.stringify(data) }),
  igaReviewItems:     (campaignId) => f(`/api/iga/access-reviews/${campaignId}/items`),
  submitReviewDecision: (campaignId, itemId, decision, comment) => f(`/api/iga/access-reviews/${campaignId}/items/${itemId}/decision`, { method: 'POST', body: JSON.stringify({ decision, comment }) }),

  // SoD Policy CRUD,
  createSodPolicy: (data) => f('/api/iga/sod-policies', { method: 'POST', body: JSON.stringify(data) }),
  updateSodPolicy: (id, data) => f(`/api/iga/sod-policies/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteSodPolicy: (id) => f(`/api/iga/sod-policies/${id}`, { method: 'DELETE' }),

  // SoD violation remediation,
  igaRemediateSod: (id) => f(`/api/iga/sod-violations/${id}/remediate`, { method: 'POST' })
});

export { api };
