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
      const err = new Error((body && body.error) || res.statusText);
      err.status = res.status;
      err.body = body;
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
});
