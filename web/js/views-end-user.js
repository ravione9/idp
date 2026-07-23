/* End-user views: Home (app launcher), My Access, Request Access, My Tasks, Settings. */
import { api } from './api.js';
import { el, esc, fmtDate, ilgBadge, initials, persistSearch, syncAppUrl, isPortalAdmin, prepareWebAuthnRegOptions, webAuthnRegResponseToJson, prepareWebAuthnAuthOptions, webAuthnAuthResponseToJson } from './ui.js';
import { icon } from './icons.js';
import { mountThemeMenu, themeOptionsHtml, wireThemePicker } from './theme.js';


function loginReturnTo() {
  const raw = new URLSearchParams(location.search).get('returnTo');
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

function googleLoginHref(returnTo) {
  return returnTo === '/'
    ? '/auth/google'
    : `/auth/google?returnTo=${encodeURIComponent(returnTo)}`;
}

const AUTH_ERROR_MESSAGES = {
  google_not_configured:
    'Google sign-in is not configured yet. Ask an administrator to complete Portal sign-in under Directory Sync → Google Workspace.',
  google_setup_failed:
    'Google sign-in could not be started. Try again or sign in with email and password.',
  missing_code:
    'Google sign-in did not complete. Try again.',
  google_access_denied:
    'Google sign-in was cancelled or denied.',
  google_oauth_error:
    'Google returned an error during sign-in. Portal login uses the OAuth Web Client (not the sync service account). Re-paste Client ID + Secret under Directory Sync → Google Workspace → Portal sign-in, and add the redirect URI shown there to Google Cloud Console.',
  wrong_hosted_domain:
    'This Google account is not from an allowed Workspace domain.',
  domain_not_permitted:
    'Your email domain is not allowed for this IdP. Use your corporate Workspace account or sign in with email and password.',
  email_not_verified:
    'Your Google email address is not verified.',
  no_employee_record:
    'No active account was found for this email. Ask an administrator to sync your user from Google Workspace or create your account.',
  adaptive_blocked:
    'Sign-in was blocked by the security policy. Contact an administrator if you believe this is a mistake.',
  auth_failed:
    'Google sign-in failed. Try again or use email and password.',
};

function showAuthErrorFromUrl(errEl) {
  const params = new URLSearchParams(location.search);
  const code = params.get('authError');
  if (!code) return;
  const detail = params.get('authDetail');
  let msg = AUTH_ERROR_MESSAGES[code] || 'Sign-in failed. Try again or use email and password.';
  if (detail) {
    msg += ` (Google: ${detail})`;
  }
  errEl.innerHTML = `<div class="alert alert-error">${esc(msg)}</div>`;
  params.delete('authError');
  params.delete('authDetail');
  const qs = params.toString();
  history.replaceState(null, '', `/login${qs ? `?${qs}` : ''}`);
}

/* ---------- Login ---------- */
export function renderLogin() {
  const loginParams = new URLSearchParams(location.search);
  const returnTo = loginParams.get('return_to') || loginReturnTo();
  const ssoResume = returnTo.startsWith('/saml/resume/') || returnTo.startsWith('/saml/launch/');
  const pendingMfaChallenge = loginParams.get('mfa_challenge');
  const pendingEnrollChallenge = loginParams.get('enroll_challenge');
  const pendingEmail = loginParams.get('email') || '';

  // If the portal session is already valid, never re-prompt password/MFA —
  // continue straight to the SSO resume/launch (or home).
  const shell = el(`
    <div class="auth-shell">
      <main class="auth-panel" style="display:flex;align-items:center;justify-content:center;width:100%">
        <div class="auth-card"><p class="muted" style="text-align:center">Checking session…</p></div>
      </main>
    </div>`);
  void api.me().then(() => {
    location.replace(returnTo);
  }).catch(() => {
    const root = document.getElementById('app');
    if (root) root.replaceChildren(renderLoginForm());
  });
  return shell;

  function renderLoginForm() {
  const root = el(`
    <div class="auth-shell">
      <aside class="auth-hero">
        <div class="brand-mark">
          <span class="brand-logo" style="width:34px;height:34px;background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.22);border-radius:6px;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-weight:700;letter-spacing:-0.02em">L</span>
          Lenskart IdP
        </div>
        <div>
          <h1>Identity infrastructure for the enterprise.</h1>
          <p>SSO, MFA, and governance in one control plane — built for operators who need precision, not noise.</p>
          <ul class="auth-features">
            <li>SAML 2.0 SSO &amp; federated login</li>
            <li>TOTP MFA, sessions, password self-service</li>
            <li>Lifecycle, access requests, certifications</li>
            <li>Attendance IGA, audit, compliance reports</li>
          </ul>
        </div>
        <div class="auth-footer">Lenskart Identity Platform</div>
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
          <p class="muted">${ssoResume ? 'Sign in to continue to your application.' : 'Enter your corporate email to continue.'}</p>
          <div id="login-error"></div>
          <form id="email-form">
            <div class="field">
              <label for="email">Work email</label>
              <input id="email" name="email" type="email" required autocomplete="username" placeholder="you@lenskart.com" />
            </div>
            <button type="submit" class="btn btn-primary btn-block btn-lg">Continue →</button>
          </form>
          <div style="text-align:center;margin-top:1rem">
            <a href="${esc(googleLoginHref(returnTo))}" class="btn btn-secondary" style="width:100%">Continue with Google</a>
          </div>
        </div>
      </main>
    </div>
  `);

  mountThemeMenu(root);

  const panel = root.querySelector('.auth-panel');

  function renderMfaEnrollStep(enrollChallengeId, email, { graceActive = false, gracePeriodHours = 24 } = {}) {
    const deferLabel = graceActive ? 'Continue without MFA for now' : 'Set up on next sign-in';
    const deferHint = graceActive
      ? `MFA must be enabled within ${gracePeriodHours} hour${gracePeriodHours === 1 ? '' : 's'} of your first required sign-in.`
      : 'You will be prompted to set up MFA the next time you sign in.';

    async function deferEnrollment() {
      try {
        const r = await api.localLoginMfaEnrollDefer(enrollChallengeId);
        if (r && r.success && r.redirect) {
          location.href = returnTo;
          return;
        }
        showPasswordStep(
          email,
          r?.message || 'Two-factor setup is required. You can complete it on your next sign-in.',
        );
      } catch (err) {
        showPasswordStep(email, err.message);
      }
    }

    const card = el(`
      <div class="auth-card">
        <h2>Set up two-factor authentication</h2>
        <p class="muted">MFA is required for ${esc(email)}. Scan the QR code with Google Authenticator, Authy, or 1Password.</p>
        <div id="enroll-error"></div>
        <div id="enroll-loading" class="muted">Loading setup…</div>
        <div id="enroll-body" hidden></div>
        <div style="text-align:center;margin-top:1.25rem;padding-top:1rem;border-top:1px solid var(--border)">
          <button type="button" class="btn btn-link" id="enroll-defer">${esc(deferLabel)}</button>
          <p class="hint" style="margin-top:0.35rem">${esc(deferHint)}</p>
        </div>
      </div>
    `);
    panel.replaceChildren(card);
    card.querySelector('#enroll-defer').addEventListener('click', () => { void deferEnrollment(); });
    const errEl = card.querySelector('#enroll-error');
    const bodyEl = card.querySelector('#enroll-body');
    const loadingEl = card.querySelector('#enroll-loading');

    api.localLoginMfaEnroll(enrollChallengeId).then((r) => {
      loadingEl.hidden = true;
      bodyEl.hidden = false;
      bodyEl.innerHTML = `
        <img src="${esc(r.qrDataUrl)}" alt="" style="background:white;padding:0.5rem;border-radius:8px;display:block;margin:0 auto" />
        <p class="subtitle" style="margin-top:0.75rem;text-align:center">Or enter this secret: <code>${esc(r.secret)}</code></p>
        <form id="enroll-confirm-form" style="margin-top:1rem">
          <div class="field"><label>6-digit code</label>
            <input name="code" type="password" required pattern="[0-9]{6}" inputmode="numeric" autocomplete="one-time-code" placeholder="••••••" />
          </div>
          <button type="submit" class="btn btn-primary btn-block btn-lg">Verify and sign in</button>
        </form>
        <div id="enroll-confirm-result"></div>`;
      bodyEl.querySelector('#enroll-confirm-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const out = bodyEl.querySelector('#enroll-confirm-result');
        out.innerHTML = '';
        try {
          const code = new FormData(e.target).get('code');
          const r2 = await api.localLoginMfaEnrollConfirm(enrollChallengeId, code);
          out.innerHTML = `<div class="alert alert-success" style="margin-top:1rem">Two-factor enabled. Save your backup codes — shown only once.</div>
            <div class="alert alert-warning" style="margin-top:0.5rem"><div>
              <div style="font-weight:600;margin-bottom:0.5rem">Backup codes</div>
              <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:0.4rem;font-family:var(--font-mono);font-size:0.9rem">
                ${r2.backupCodes.map((c) => `<div>${esc(c)}</div>`).join('')}
              </div></div></div>
            <button type="button" class="btn btn-primary btn-block btn-lg" id="enroll-done" style="margin-top:1rem">Continue</button>`;
          out.querySelector('#enroll-done').addEventListener('click', () => {
            location.href = returnTo;
          });
        } catch (err) {
          out.innerHTML = `<div class="alert alert-error" style="margin-top:1rem">${esc(err.message)}</div>`;
        }
      });
    }).catch((err) => {
      loadingEl.hidden = true;
      errEl.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
    });
  }

  function renderMfaStep(challengeId, email, availableMethods = ['totp']) {
    const methods = new Set(availableMethods || ['totp']);
    const hintParts = [];
    if (methods.has('totp')) hintParts.push('Authenticator code');
    if (methods.has('backup_codes')) hintParts.push('backup code');
    if (methods.has('email_otp') || methods.has('sms_otp')) hintParts.push('email/SMS OTP');
    const hint = hintParts.length
      ? `${hintParts.join(', ').replace(/^./, (c) => c.toUpperCase())}.`
      : 'Enter your verification code.';
    const card = el(`
      <div class="auth-card">
        <h2>Two-factor authentication</h2>
        <p class="muted">Verify your identity for ${esc(email)}.</p>
        <div id="mfa-error"></div>
        <form id="mfa-form">
          <div class="field"><label>Verification code</label>
            <input name="code" type="password" required pattern="[0-9]{6,8}" inputmode="numeric" autocomplete="one-time-code" placeholder="••••••" />
            <p class="hint">${esc(hint)}</p></div>
          <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.75rem">
            ${methods.has('email_otp') ? '<button type="button" class="btn btn-secondary btn-sm" id="mfa-send-email">Email me a code</button>' : ''}
            ${methods.has('sms_otp') ? '<button type="button" class="btn btn-secondary btn-sm" id="mfa-send-sms">Text me a code</button>' : ''}
            ${methods.has('webauthn') ? '<button type="button" class="btn btn-secondary btn-sm" id="mfa-use-passkey">Use passkey</button>' : ''}
          </div>
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
        location.href = returnTo;
      } catch (err) {
        merr.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
      }
    });
    card.querySelector('#mfa-send-email')?.addEventListener('click', async () => {
      merr.innerHTML = '';
      try {
        const r = await api.localLoginMfaSendOtp(challengeId, 'email_otp');
        merr.innerHTML = `<div class="alert alert-info">${r.devCode ? `Dev code: ${esc(r.devCode)}` : 'Code sent to your email.'}</div>`;
      } catch (err) {
        merr.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
      }
    });
    card.querySelector('#mfa-send-sms')?.addEventListener('click', async () => {
      merr.innerHTML = '';
      try {
        const r = await api.localLoginMfaSendOtp(challengeId, 'sms_otp');
        merr.innerHTML = `<div class="alert alert-info">${r.devCode ? `Dev code: ${esc(r.devCode)}` : 'Code sent via SMS.'}</div>`;
      } catch (err) {
        merr.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
      }
    });
    card.querySelector('#mfa-use-passkey')?.addEventListener('click', async () => {
      merr.innerHTML = '';
      if (!window.PublicKeyCredential) {
        merr.innerHTML = '<div class="alert alert-error">WebAuthn not supported in this browser.</div>';
        return;
      }
      try {
        const { options, webauthnChallengeId } = await api.localLoginMfaWebAuthnOptions(challengeId);
        const cred = await navigator.credentials.get({
          publicKey: prepareWebAuthnAuthOptions(options),
        });
        await api.localLoginMfaWebAuthnVerify(challengeId, webauthnChallengeId, webAuthnAuthResponseToJson(cred));
        location.href = returnTo;
      } catch (err) {
        merr.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
      }
    });
  }

  function showPasswordStep(email, infoMessage) {
    const initial = (email.trim().charAt(0) || '?').toUpperCase();
    const card = el(`
      <div class="auth-card" id="step-password">
        <div class="auth-avatar-circle">${esc(initial)}</div>
        <h2 style="text-align:center">Welcome back</h2>
        <div class="auth-email-chip">
          <span>${esc(email)}</span>
          <a href="#" id="back-to-email">· Not you?</a>
        </div>
        <div id="pw-info"></div>
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

    if (infoMessage) {
      card.querySelector('#pw-info').innerHTML = `<div class="alert alert-warning">${esc(infoMessage)}</div>`;
    }

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
        if (r && r.enrollRequired && r.enrollChallengeId) {
          renderMfaEnrollStep(r.enrollChallengeId, email, {
            graceActive: !!r.graceActive,
            gracePeriodHours: r.gracePeriodHours ?? 24,
          });
          return;
        }
        if (r && r.mfaRequired && r.challengeId) {
          renderMfaStep(r.challengeId, email, r.availableMethods);
          return;
        }
        location.href = returnTo;
      } catch (err) {
        pwErr.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
      }
    });
  }

  function showEmailStep() {
    const card = el(`
      <div class="auth-card" id="step-email">
        <h2>Sign in to Lenskart IdP</h2>
        <p class="muted">${ssoResume ? 'Sign in to continue to your application.' : 'Enter your corporate email to continue.'}</p>
        <div id="login-error"></div>
        <form id="email-form">
          <div class="field">
            <label for="email">Work email</label>
            <input id="email" name="email" type="email" required autocomplete="username" placeholder="you@lenskart.com" />
          </div>
          <button type="submit" class="btn btn-primary btn-block btn-lg">Continue →</button>
        </form>
        <div style="text-align:center;margin-top:1rem">
          <a href="${esc(googleLoginHref(returnTo))}" class="btn btn-secondary" style="width:100%">Continue with Google</a>
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

  // Google OIDC may redirect here with an MFA / enroll challenge after passwordless Google auth
  if (pendingMfaChallenge) {
    const methodsRaw = loginParams.get('mfa_methods') || 'totp';
    const methods = methodsRaw.split(',').map((m) => m.trim()).filter(Boolean);
    renderMfaStep(pendingMfaChallenge, pendingEmail || 'your account', methods.length ? methods : ['totp']);
    return root;
  }
  if (pendingEnrollChallenge) {
    renderMfaEnrollStep(pendingEnrollChallenge, pendingEmail || 'your account', {
      graceActive: false,
      gracePeriodHours: 24,
    });
    return root;
  }

  wireEmailForm(root.querySelector('#step-email'));
  showAuthErrorFromUrl(root.querySelector('#login-error'));

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
}

/* ---------- Home: app launcher (JumpCloud-style with favorites + search) ---------- */
export async function viewHome(me, content, initialTab = 'all') {
  const isAdmin = isPortalAdmin(me);

  let allApps = [];
  let samlEnabled = false;
  try {
    const r = await api.apps();
    samlEnabled = !!r.samlEnabled;
    allApps = r.data || [];
  } catch { /* ignore */ }

  let favs = JSON.parse(localStorage.getItem('idp_fav_apps') || '[]');
  let activeTab = initialTab === 'favs' ? 'favs' : 'all';
  let searchQ = '';

  function renderAppTile(app) {
    const fb = app.iconUrl || app.icon_url
      ? `<img class="app-icon" src="${esc(app.iconUrl || app.icon_url)}" alt="" onerror="this.style.display='none'" />`
      : `<div class="app-icon app-icon-fallback">${esc((app.name || '?').charAt(0).toUpperCase())}</div>`;
    const launch = app.launchUrl || (app.slug ? `/saml/launch/${app.slug}` : '#');
    const appKey = app.slug || app.name;
    const isFav = favs.includes(appKey);
    const ipHint = app.ipRestricted
      ? ' title="IP-restricted — launch verifies your public IP"'
      : ` title="${esc(app.name)}"`;
    return `<div class="app-tile-wrap" style="position:relative">
      <a class="app-tile" href="${esc(launch)}" target="_blank" rel="noopener"${ipHint}>
        <span class="saml-badge">S</span>${fb}
        <span class="app-name">${esc(app.name)}</span>
        ${app.ipRestricted ? '<span class="saml-badge" style="left:auto;right:0.35rem;background:#b45309" title="IP restricted">IP</span>' : ''}
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
        return `<div class="empty-state"><span class="empty-icon">⭐</span><p>No favorites yet — tap or click ☆ on an app tile to add it here.</p></div>`;
      }
      if (!samlEnabled) {
        return `<p class="subtitle" style="text-align:center;padding:2rem 0">${isAdmin ? 'SAML IdP signing keys not configured — see Authentication.' : 'Contact your administrator to enable SSO.'}</p>`;
      }
      return `<div class="empty-state"><span class="empty-icon">◎</span><p>No applications match your search.</p></div>`;
    }
    return `<div class="app-grid">${items.map(renderAppTile).join('')}</div>`;
  }

  const wrap = el(`
    <div class="enduser-page enduser-home">
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
          <button class="home-tab${activeTab === 'all' ? ' active' : ''}" data-tab="all">All Apps</button>
          <button class="home-tab${activeTab === 'favs' ? ' active' : ''}" data-tab="favs">⭐ Favorites</button>
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
  persistSearch(wrap.querySelector('#home-search'), 'home-apps');

  wrap.querySelectorAll('.home-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      activeTab = tab.dataset.tab;
      wrap.querySelectorAll('.home-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === activeTab));
      syncAppUrl('home', activeTab, 'all');
      redraw();
    });
  });

  if (!wrap.querySelector('#home-search').value) redraw();
  content.replaceChildren(wrap);
}

/* ---------- My Access ---------- */
export async function viewMyAccess(content) {
  const wrap = el(`
    <div class="enduser-page enduser-myaccess">
      <div class="page-header page-header--compact">
        <div><h1>My Access</h1><p class="subtitle">Entitlements and roles currently assigned to you</p></div>
        <div class="page-header-actions"><a href="#" data-go="request" class="btn btn-primary">Request access</a></div>
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
    <div class="enduser-page enduser-request">
      <div class="page-header page-header--compact">
        <div><h1>Request Access</h1><p class="subtitle">Request SSO only for apps you do not already have — assigned apps open from All Applications with no request needed</p></div>
      </div>

      <!-- search + filter bar -->
      <div class="card ra-filter-card" style="margin-bottom:0;display:flex;gap:0.75rem;flex-wrap:wrap;align-items:center">
        <input class="form-input" id="ra-search" placeholder="Search connected apps…" style="flex:1;min-width:200px">
        <select class="form-select" id="ra-type" style="width:auto">
          <option value="APP">Connected applications</option>
          <option value="">All types</option>
          <option value="ENTITLEMENT">Curated entitlements</option>
          <option value="ROLE">Business Roles</option>
        </select>
      </div>

      <div id="ra-catalog"><div class="loading-row"><span class="spinner"></span></div></div>

      <!-- request drawer (hidden by default) -->
      <div id="ra-backdrop" class="ra-backdrop" style="display:none;position:fixed;inset:0;background:var(--overlay);z-index:190"></div>
      <div id="ra-drawer" class="ra-drawer" style="display:none;position:fixed;right:0;top:0;height:100%;width:420px;max-width:100vw;background:var(--surface);border-left:1px solid var(--border);box-shadow:-4px 0 16px rgba(0,0,0,.15);z-index:200;overflow-y:auto">
        <div class="ra-drawer-inner" style="padding:1.5rem">
          <div class="ra-drawer-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem">
            <h2 style="margin:0" id="ra-d-title">Request access</h2>
            <button id="ra-d-close" class="btn btn-sm btn-secondary">✕</button>
          </div>
          <div id="ra-d-body"></div>
        </div>
      </div>
    </div>`);
  content.replaceChildren(wrap);
  const drawer = wrap.querySelector('#ra-drawer');
  const backdrop = wrap.querySelector('#ra-backdrop');

  function closeRequestDrawer() {
    drawer.style.display = 'none';
    backdrop.style.display = 'none';
  }

  // Close drawer
  wrap.querySelector('#ra-d-close').addEventListener('click', closeRequestDrawer);
  backdrop.addEventListener('click', closeRequestDrawer);

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
    const typeLabel = {
      APP: 'Connected applications (SAML SSO)',
      ENTITLEMENT: 'Curated entitlements',
      ROLE: 'Business Roles',
    };
    const typeOrder = ['APP', 'ENTITLEMENT', 'ROLE'];
    let html = '';
    for (const t of typeOrder) {
      const items = groups[t] || [];
      if (!items.length) continue;
      html += `<h3 class="section-title">${typeLabel[t] || t}</h3>
        <div class="grid-3" style="margin-bottom:1.5rem">
          ${items.map(item => `
            <div class="card ra-item-card" style="cursor:pointer;transition:box-shadow .15s" data-req-id="${esc(String(item.id))}" data-req-type="${esc(item._type)}">
              <div style="display:flex;gap:0.75rem;align-items:flex-start">
                ${item.icon_url ? `<img src="${esc(item.icon_url)}" alt="" style="width:36px;height:36px;border-radius:6px;object-fit:cover;flex-shrink:0" onerror="this.style.display='none'">` : `<div style="width:36px;height:36px;border-radius:6px;background:var(--primary);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;flex-shrink:0">${esc((item.name||'?').charAt(0).toUpperCase())}</div>`}
                <div style="flex:1;min-width:0">
                  <div style="font-weight:600;margin-bottom:0.25rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.name)}</div>
                  <div class="muted" style="font-size:0.78rem;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${esc(item.description || (item._type === 'APP' ? 'Request SSO access to this connected application' : ''))}</div>
                </div>
              </div>
              <div style="margin-top:0.75rem;display:flex;justify-content:space-between;align-items:center">
                <span class="badge badge-info">${item._type === 'APP' ? 'SSO' : esc(item._type)}</span>
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
        <div class="ra-date-row" style="display:flex;gap:0.5rem">
          <div style="flex:1"><label class="form-label" style="font-size:0.8rem">From</label><input class="form-input" id="ra-from" type="date" value="${fmt(now)}"></div>
          <div style="flex:1"><label class="form-label" style="font-size:0.8rem">Until</label><input class="form-input" id="ra-until" type="date" value="${fmt(defEnd)}"></div>
        </div>
      </div>
      <div id="ra-sod-check" style="margin-bottom:1rem"></div>
      <div id="ra-req-msg" style="margin-bottom:1rem"></div>
      <div class="ra-action-row" style="display:flex;gap:0.5rem">
        <button class="btn btn-primary" id="ra-submit" style="flex:1">Submit Request</button>
        <button class="btn btn-secondary" id="ra-d-cancel">Cancel</button>
      </div>`;
    drawer.style.display = 'block';
    backdrop.style.display = 'block';
    wrap.querySelector('#ra-d-cancel').addEventListener('click', closeRequestDrawer);
    wrap.querySelector('#ra-submit').addEventListener('click', async () => {
      const just = wrap.querySelector('#ra-just').value.trim();
      const targetInput = wrap.querySelector('#ra-target').value.trim();
      if (!just) { wrap.querySelector('#ra-req-msg').innerHTML = `<div class="alert alert-error">Justification is required.</div>`; return; }
      const btn = wrap.querySelector('#ra-submit');
      btn.disabled = true; btn.textContent = 'Submitting…';
      wrap.querySelector('#ra-req-msg').innerHTML = '';
      wrap.querySelector('#ra-sod-check').innerHTML = '';
      try {
        const itemType = type === 'APP' ? 'APP_ACCESS' : type;
        await api.igaSubmitRequest({
          itemType,
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

  // Load catalog — JIT apps the user may request (+ entitlements/roles, excluding held items)
  try {
    const [appsR, entsR, rolesR, myAccessR] = await Promise.all([
      api.igaRequestableApps().catch(() => ({ data: [] })),
      api.igaEntitlements({ requestable: 1 }).catch(() => ({ data: [] })),
      api.listRequestableRoles().catch(() => ({ data: [] })),
      api.igaMyAccess().catch(() => ({ data: [] })),
    ]);
    const myAccess = myAccessR.data || [];
    const assignedEntitlementIds = new Set(myAccess.map(r => String(r.entitlement_id)));

    // Apps already filtered server-side (JIT + not assigned + group-eligible)
    const apps = appsR.data || [];
    const ents = (entsR.data || []).filter(e => !assignedEntitlementIds.has(String(e.id)));
    const roles = (rolesR.data || []).filter(r => r.active);
    allItems = [
      ...apps.map(a => ({ ...a, _type: 'APP' })),
      ...ents.map(e => ({ ...e, _type: 'ENTITLEMENT' })),
      ...roles.map(r => ({ ...r, _type: 'ROLE' })),
    ];
    wrap.querySelector('#ra-search').addEventListener('input', renderCatalog);
    wrap.querySelector('#ra-type').addEventListener('change', renderCatalog);
    persistSearch(wrap.querySelector('#ra-search'), 'request-access');
    if (!allItems.length) {
      wrap.querySelector('#ra-catalog').innerHTML = `<div class="empty-state"><div class="empty-icon">◎</div>
        <p>Nothing to request right now.</p>
        <p class="muted" style="max-width:36rem;margin:0.75rem auto 0;font-size:0.9rem">
          Apps already assigned to you are under <strong>All Applications</strong> — launch them directly (no request).
          New apps appear here only if an admin enabled Request Access and you do not already have a grant or pending request.
        </p>
      </div>`;
    } else {
      renderCatalog();
    }
  } catch(err) {
    wrap.querySelector('#ra-catalog').innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
  }
}

/* ---------- My Tasks — approvals + access review certifications ---------- */
export async function viewMyTasks(content) {
  const wrap = el(`
    <div class="enduser-page enduser-tasks">
      <div class="page-header page-header--compact"><div>
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
export async function viewSettings(me, content, initialTab = 'profile') {
  const isLocal = me.session?.iss === 'local';
  const tabs = ['profile', ...(isLocal ? ['security'] : []), 'sessions', 'mfa', 'appearance'];
  const validTab = tabs.includes(initialTab) ? initialTab : 'profile';
  const wrap = el(`
    <div class="enduser-page enduser-settings">
      <div class="page-header page-header--compact"><div><h1>Account</h1><p class="subtitle">Profile, security, sessions and capabilities</p></div></div>
      <div class="tabs">
        <button class="tab${validTab === 'profile' ? ' active' : ''}" data-tab="profile">Profile</button>
        ${isLocal ? `<button class="tab${validTab === 'security' ? ' active' : ''}" data-tab="security">Security</button>` : ''}
        <button class="tab${validTab === 'sessions' ? ' active' : ''}" data-tab="sessions">Sessions</button>
        <button class="tab${validTab === 'mfa' ? ' active' : ''}" data-tab="mfa">Two-factor</button>
        <button class="tab${validTab === 'appearance' ? ' active' : ''}" data-tab="appearance">Appearance</button>
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
        <div class="kv"><div class="k">Employee ID</div><div class="v"><code>${esc(me.employee?.employee_number || me.employee?.emp_id || '—')}</code></div></div>
        <div class="kv"><div class="k">Designation</div><div class="v"><span class="badge badge-info">${esc(me.employee?.role || '—')}</span></div></div>
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

    const allowed = new Set(s.allowedMethods || ['totp', 'backup_codes']);
    const enrolled = new Set(s.methods || []);
    const defs = [
      { key: 'totp', label: 'Authenticator App (TOTP)', desc: 'Google Authenticator, Authy, 1Password.' },
      { key: 'backup_codes', label: 'Backup Codes', desc: 'Single-use recovery codes (issued with TOTP).' },
      { key: 'webauthn', label: 'WebAuthn / Passkeys', desc: 'Hardware keys, Touch ID, Windows Hello.' },
      { key: 'email_otp', label: 'Email OTP', desc: 'One-time code sent to your corporate email.' },
      { key: 'sms_otp', label: 'SMS OTP', desc: 'One-time code sent to your registered mobile.' },
    ].filter((d) => allowed.has(d.key) && d.key !== 'backup_codes');

    function promptMfaStepUp(actionLabel) {
      const password = prompt(`Enter your password to ${actionLabel} (leave blank if you signed in with Google):`) ?? '';
      const code = prompt('Enter a current verification or backup code:') ?? '';
      if (!code.trim()) return null;
      const body = { code: code.trim() };
      if (password.trim()) body.currentPassword = password.trim();
      return body;
    }

    const cards = defs.map((d) => {
      const isOn = enrolled.has(d.key) || (d.key === 'totp' && s.methodDetails?.totp?.enabled);
      const statusBadge = isOn
        ? '<span class="badge badge-success">Enrolled</span>'
        : '<span class="badge badge-neutral">Not enrolled</span>';
      const policyBadge = '<span class="badge badge-info">Live</span>';
      let action = '';
      if (d.key === 'totp' && !isOn) action = '<button class="btn btn-primary btn-sm" data-enroll="totp">Set up TOTP</button>';
      if (d.key === 'email_otp' && !isOn) action = '<button class="btn btn-primary btn-sm" data-enroll="email">Send email code</button>';
      if (d.key === 'sms_otp' && !isOn) action = '<button class="btn btn-primary btn-sm" data-enroll="sms">Send SMS code</button>';
      if (d.key === 'webauthn') action = '<button class="btn btn-primary btn-sm" data-enroll="webauthn">Register passkey</button>';
      if (isOn && d.key === 'email_otp') action = '<button class="btn btn-secondary btn-sm" data-disable="email">Disable</button>';
      if (isOn && d.key === 'sms_otp') action = '<button class="btn btn-secondary btn-sm" data-disable="sms">Disable</button>';
      return `<div class="mfa-method-card card">
        <div class="mfa-method-card-head">
          <strong>${esc(d.label)}</strong>
          <div class="mfa-method-card-badges">${policyBadge}${statusBadge}</div>
        </div>
        <p class="muted">${esc(d.desc)}</p>
        <div class="mfa-method-card-actions">${action}</div>
        <div class="mfa-method-msg" data-method="${esc(d.key)}"></div>
      </div>`;
    }).join('');

    target.innerHTML = `<div class="mfa-settings">
      <div class="card" style="margin-bottom:1rem">
        <h2>Multi-factor authentication</h2>
        <p class="subtitle" style="margin-bottom:0.75rem">
          ${s.enabled
            ? `<span class="badge badge-success">Active</span> Last used ${s.lastUsedAt ? fmtDate(s.lastUsedAt) : '—'}`
            : '<span class="badge badge-warning">Not active</span> Enroll at least one method below.'}
          ${s.remainingBackupCodes ? ` · ${s.remainingBackupCodes} backup codes left` : ''}
        </p>
        ${s.enabled ? `<div style="display:flex;gap:0.5rem;flex-wrap:wrap">
          <button class="btn btn-secondary btn-sm" id="mfa-regen">Regenerate backup codes</button>
          <button class="btn btn-danger btn-sm" id="mfa-disable-all">Disable all MFA</button>
        </div><div id="mfa-action-result" style="margin-top:0.75rem"></div>` : ''}
      </div>
      <div class="section-title">Available Methods</div>
      <div class="mfa-method-grid">${cards}</div>
      <div id="mfa-enroll-panel"></div>
    </div>`;

    target.querySelector('#mfa-disable-all')?.addEventListener('click', async () => {
      if (!confirm('Disable all MFA methods?')) return;
      const body = promptMfaStepUp('disable MFA');
      if (!body) return;
      try { await api.mfaDisable(body); mfa(); } catch (err) { alert(err.message); }
    });
    target.querySelector('#mfa-regen')?.addEventListener('click', async () => {
      if (!confirm('Replace all backup codes?')) return;
      const body = promptMfaStepUp('regenerate backup codes');
      if (!body) return;
      try {
        const r = await api.mfaRegenCodes(body);
        target.querySelector('#mfa-action-result').innerHTML = `<div class="alert alert-warning"><div>
          <div style="font-weight:600;margin-bottom:0.5rem">Save these backup codes — shown only once</div>
          <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:0.4rem;font-family:var(--font-mono);font-size:0.9rem">
            ${r.backupCodes.map((c) => `<div>${esc(c)}</div>`).join('')}
          </div></div></div>`;
      } catch (err) { alert(err.message); }
    });

    target.querySelector('[data-enroll="totp"]')?.addEventListener('click', async () => {
      const panel = target.querySelector('#mfa-enroll-panel');
      try {
        const r = await api.mfaEnroll();
        panel.innerHTML = `<div class="card" style="margin-top:1rem;max-width:560px">
          <h3>Set up authenticator app</h3>
          <p class="subtitle">Scan the QR code or enter the secret manually.</p>
          <img src="${esc(r.qrDataUrl)}" alt="" style="background:white;padding:0.5rem;border-radius:8px;max-width:220px" />
          <p class="subtitle" style="margin-top:0.75rem">Secret: <code>${esc(r.secret)}</code></p>
          <form id="mfa-confirm" style="margin-top:1rem">
            <div class="field"><label>6-digit code</label><input name="code" type="password" required pattern="[0-9]{6}" inputmode="numeric" autocomplete="one-time-code" placeholder="••••••" /></div>
            <button class="btn btn-primary" type="submit">Verify and enable</button>
          </form>
          <div id="mfa-confirm-result"></div>
        </div>`;
        panel.querySelector('#mfa-confirm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const out = panel.querySelector('#mfa-confirm-result');
          try {
            const code = new FormData(e.target).get('code');
            const r2 = await api.mfaConfirm(code);
            out.innerHTML = `<div class="alert alert-success">TOTP enabled.</div>
              <div class="alert alert-warning" style="margin-top:0.5rem"><div style="font-weight:600;margin-bottom:0.5rem">Backup codes — save now</div>
              <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:0.4rem;font-family:var(--font-mono);font-size:0.9rem">
                ${r2.backupCodes.map((c) => `<div>${esc(c)}</div>`).join('')}
              </div></div>
              <button class="btn btn-secondary" id="mfa-done" style="margin-top:0.75rem">Done</button>`;
            out.querySelector('#mfa-done').addEventListener('click', () => mfa());
          } catch (err) {
            out.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
          }
        });
      } catch (err) {
        panel.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
      }
    });

    async function otpEnroll(channel, sendFn, confirmFn) {
      const msgEl = target.querySelector(`.mfa-method-msg[data-method="${channel === 'email' ? 'email_otp' : 'sms_otp'}"]`);
      try {
        const r = await sendFn();
        msgEl.innerHTML = `<form class="mfa-otp-confirm" style="margin-top:0.65rem">
          <div class="field"><label>Enter 6-digit code</label>
            <input name="code" type="password" required pattern="[0-9]{6}" inputmode="numeric" autocomplete="one-time-code" placeholder="••••••" />
          </div>
          ${r.devCode ? `<p class="form-hint">Dev code: <code>${esc(r.devCode)}</code></p>` : ''}
          <button class="btn btn-primary btn-sm" type="submit">Confirm</button>
        </form>`;
        msgEl.querySelector('form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const code = new FormData(e.target).get('code');
          try {
            await confirmFn(code);
            mfa();
          } catch (err) {
            msgEl.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
          }
        });
      } catch (err) {
        msgEl.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
      }
    }

    target.querySelector('[data-enroll="email"]')?.addEventListener('click', () =>
      otpEnroll('email', () => api.mfaEmailSend(), (code) => api.mfaEmailConfirm(code)));
    target.querySelector('[data-enroll="sms"]')?.addEventListener('click', () =>
      otpEnroll('sms', () => api.mfaSmsSend(), (code) => api.mfaSmsConfirm(code)));

    target.querySelector('[data-disable="email"]')?.addEventListener('click', async () => {
      const body = promptMfaStepUp('disable Email OTP');
      if (!body) return;
      try { await api.mfaEmailDisable(body); mfa(); } catch (err) { alert(err.message); }
    });
    target.querySelector('[data-disable="sms"]')?.addEventListener('click', async () => {
      const body = promptMfaStepUp('disable SMS OTP');
      if (!body) return;
      try { await api.mfaSmsDisable(body); mfa(); } catch (err) { alert(err.message); }
    });

    target.querySelector('[data-enroll="webauthn"]')?.addEventListener('click', async () => {
      const msgEl = target.querySelector('.mfa-method-msg[data-method="webauthn"]');
      if (!window.PublicKeyCredential) {
        msgEl.innerHTML = '<div class="alert alert-error">WebAuthn is not supported in this browser.</div>';
        return;
      }
      const name = prompt('Name this passkey (e.g. MacBook Touch ID):') || 'Passkey';
      try {
        const { options, challengeId } = await api.mfaWebAuthnOptions();
        const cred = await navigator.credentials.create({
          publicKey: prepareWebAuthnRegOptions(options),
        });
        await api.mfaWebAuthnVerify(challengeId, webAuthnRegResponseToJson(cred), name);
        mfa();
      } catch (err) {
        msgEl.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
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
    if (!tabs.includes(name)) name = 'profile';
    wrap.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    syncAppUrl('settings', name, 'profile');
    if (name === 'profile') profile();
    else if (name === 'security') security();
    else if (name === 'sessions') sessions();
    else if (name === 'mfa') mfa();
    else if (name === 'appearance') appearance();
  }
  wrap.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => showTab(tab.dataset.tab)));
  showTab(validTab);
}
