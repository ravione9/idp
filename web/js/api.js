/* API client — small wrapper around fetch with credential cookies and JSON.
 * Public / end-user surface only. Admin endpoints live in api-admin.js
 * (served only to authenticated sessions). */
export const api = {
  async fetch(path, options = {}) {
    const res = await fetch(path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const ct = res.headers.get('content-type') || '';
    const raw = await res.text();
    let body;
    if (ct.includes('json')) {
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        const preview = raw.slice(0, 80).replace(/\s+/g, ' ').trim();
        const err = new Error(
          res.ok
            ? 'Server returned invalid JSON — try refreshing or signing in again'
            : `Request failed (HTTP ${res.status})${preview ? `: ${preview}` : ''}`,
        );
        err.status = res.status;
        err.body = raw;
        throw err;
      }
    } else {
      body = raw;
    }
    if (!res.ok) {
      // Prefer body.message (used by connector test + most IGA endpoints),
      // then body.error (used by validation errors), then HTTP status text.
      const err = new Error((body && (body.message || body.error)) || res.statusText);
      err.status = res.status;
      err.body   = body;
      const code = body && body.code;
      if (
        res.status === 401
        && typeof location !== 'undefined'
        && !path.startsWith('/auth/')
        && path !== '/api/me'
        && (code === 'SESSION_EXPIRED' || code === 'NO_SESSION' || code === 'BAD_SIGNATURE')
      ) {
        location.href = '/login?reason=expired';
      }
      throw err;
    }
    return body;
  },
};

const f = api.fetch;
Object.assign(api, {
  me:               (opts = {}) => f('/api/me', opts),
  apps:             () => f('/api/apps'),
  diagz:            () => f('/diagz'),
  /** Public login branding (logo, accent, hero copy) — no auth. */
  publicBranding:   () => f('/api/public/branding'),
  localLogin: (email, password, returnTo) =>
    f('/auth/local/login', { method: 'POST', body: JSON.stringify({ email, password, ...(returnTo ? { returnTo } : {}) }) }),
  localLoginMfa:    (challengeId, code, opts = {}) =>
    f('/auth/local/login/mfa-verify', {
      method: 'POST',
      body: JSON.stringify({ challengeId, code: String(code || '').replace(/\s+/g, '').trim() }),
      ...opts,
    }),
  localLoginMfaEnroll: (enrollChallengeId) =>
    f('/auth/local/login/mfa-enroll', { method: 'POST', body: JSON.stringify({ enrollChallengeId }) }),
  localLoginMfaEnrollConfirm: (enrollChallengeId, code) =>
    f('/auth/local/login/mfa-enroll/confirm', { method: 'POST', body: JSON.stringify({ enrollChallengeId, code: String(code || '').replace(/\s+/g, '').trim() }) }),
  localLoginMfaEnrollDefer: (enrollChallengeId) =>
    f('/auth/local/login/mfa-enroll/defer', { method: 'POST', body: JSON.stringify({ enrollChallengeId }) }),
  logout:           () => f('/auth/logout', { method: 'POST' }),
  changePassword:   (currentPassword, newPassword) =>
    f('/api/me/password', { method: 'PUT', body: JSON.stringify({ currentPassword, newPassword }) }),
  listSessions:     () => f('/api/me/sessions'),
  revokeSession:    (id) => f(`/api/me/sessions/${id}`, { method: 'DELETE' }),
  mfaStatus:        () => f('/api/me/mfa'),
  mfaEnroll:        () => f('/api/me/mfa/enroll', { method: 'POST' }),
  mfaConfirm:       (code) => f('/api/me/mfa/confirm', { method: 'POST', body: JSON.stringify({ code }) }),
  mfaDisable:       (body) => f('/api/me/mfa/disable', { method: 'POST', body: JSON.stringify(body || {}) }),
  mfaRegenCodes:    (body) => f('/api/me/mfa/regenerate-codes', { method: 'POST', body: JSON.stringify(body || {}) }),
  mfaEmailSend:     () => f('/api/me/mfa/email/send', { method: 'POST' }),
  mfaEmailConfirm:  (code) => f('/api/me/mfa/email/confirm', { method: 'POST', body: JSON.stringify({ code }) }),
  mfaEmailDisable:  (body) => f('/api/me/mfa/email/disable', { method: 'POST', body: JSON.stringify(body || {}) }),
  mfaSmsSend:       () => f('/api/me/mfa/sms/send', { method: 'POST' }),
  mfaSmsConfirm:    (code) => f('/api/me/mfa/sms/confirm', { method: 'POST', body: JSON.stringify({ code }) }),
  mfaSmsDisable:    (body) => f('/api/me/mfa/sms/disable', { method: 'POST', body: JSON.stringify(body || {}) }),
  mfaWebAuthnOptions: () => f('/api/me/mfa/webauthn/register/options', { method: 'POST' }),
  mfaWebAuthnVerify:  (challengeId, response, name) =>
    f('/api/me/mfa/webauthn/register/verify', { method: 'POST', body: JSON.stringify({ challengeId, response, name }) }),
  mfaWebAuthnList:    () => f('/api/me/mfa/webauthn/credentials'),
  mfaWebAuthnDelete:  (id, body) => f(`/api/me/mfa/webauthn/credentials/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify(body || {}) }),
  listMyVault:        () => f('/api/me/vault'),
  createMyVaultEntry: (data) => f('/api/me/vault', { method: 'POST', body: JSON.stringify(data) }),
  updateMyVaultEntry: (id, data) => f(`/api/me/vault/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteMyVaultEntry: (id) => f(`/api/me/vault/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  revealMyVaultEntry: (id) => f(`/api/me/vault/${encodeURIComponent(id)}/reveal`, { method: 'POST' }),
  localLoginMfaSendOtp: (challengeId, channel) =>
    f('/auth/local/login/mfa-send-otp', { method: 'POST', body: JSON.stringify({ challengeId, channel }) }),
  localLoginMfaWebAuthnOptions: (challengeId) =>
    f('/auth/local/login/mfa-webauthn/options', { method: 'POST', body: JSON.stringify({ challengeId }) }),
  localLoginMfaWebAuthnVerify: (challengeId, webauthnChallengeId, response) =>
    f('/auth/local/login/mfa-webauthn/verify', { method: 'POST', body: JSON.stringify({ challengeId, webauthnChallengeId, response }) }),
  /** Critical-app MFA step-up while already signed in. */
  sessionMfaChallenge: (returnTo) =>
    f('/auth/session/mfa-challenge', { method: 'POST', body: JSON.stringify({ ...(returnTo ? { returnTo } : {}) }) }),
  reportBrowserAppSignals: (domains) => f('/api/me/browser-app-signals', { method: 'POST', body: JSON.stringify({ domains }) }),
  igaRequestableApps: (opts = {}) => {
    const q = new URLSearchParams();
    if (opts.explain) q.set('explain', '1');
    const qs = q.toString();
    return f(`/api/iga/requestable-applications${qs ? `?${qs}` : ''}`);
  },
  igaEntitlements:  (opts) => {
    const q = new URLSearchParams();
    if (typeof opts === 'string' && opts) q.set('appId', opts);
    else if (opts && typeof opts === 'object') {
      if (opts.appId) q.set('appId', opts.appId);
      if (opts.connectorId) q.set('connectorId', opts.connectorId);
      if (opts.active != null) q.set('active', String(opts.active));
      if (opts.requestable != null) q.set('requestable', String(opts.requestable));
      if (opts.limit) q.set('limit', String(opts.limit));
    }
    const qs = q.toString();
    return f(`/api/iga/entitlements${qs ? `?${qs}` : ''}`);
  },
  igaMyAccess:      () => f('/api/iga/entitlements/me'),
  igaAccessReqs:    (scope = 'mine', status = '') =>
    f(`/api/iga/access-requests?scope=${encodeURIComponent(scope)}${status ? `&status=${encodeURIComponent(status)}` : ''}`),
  igaMyTasks:       () => f('/api/iga/access-requests?scope=tasks'),
  igaMyReviews:     () => f('/api/iga/access-reviews/me'),
  listRequestableRoles:  () => f('/api/iga/roles'),
  igaSubmitRequest:  (data) => f('/api/iga/access-requests', { method: 'POST', body: JSON.stringify(data) }),
  igaRequestDecision: (id, decision, comment, adminOverride = false) =>
    f(`/api/iga/access-requests/${id}/decision`, {
      method: 'POST',
      body: JSON.stringify({
        decision,
        comment,
        ...(adminOverride ? { adminOverride: true } : {}),
      }),
    }),
  bootstrapStatus:  () => f('/auth/local/bootstrap-status'),
  bootstrapAdmin:   (data) => f('/auth/local/bootstrap', { method: 'POST', body: JSON.stringify(data) })
});
