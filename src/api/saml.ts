/**
 * LILG — SAML 2.0 IdP HTTP endpoints
 *
 *   GET  /saml/metadata  — IdP metadata XML (for SP configuration)
 *   GET  /saml/sso       — HTTP-Redirect SSO (AuthnRequest)
 *   POST /saml/sso       — HTTP-POST SSO (AuthnRequest)
 */

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { isSamlEnabled } from '../config.js';
import { requireAuth, resolveSession } from '../auth/middleware.js';
import { requireRole } from '../auth/rbac.js';
import { redis } from '../auth/session-store.js';
import logger from '../utils/logger.js';
import {
  createIdpInitiatedLoginResponse,
  createSpInitiatedLoginResponse,
  extractIssuerFromAuthnRequest,
  getIdpMetadataXml,
  type SamlBinding,
} from '../saml/idp.js';
import { canReceiveSamlAssertion } from '../saml/entitlements.js';
import { resolveSamlRelayState } from '../saml/launch-url.js';
import {
  getEmployeeForSaml,
  getServiceProviderByEntityId,
  getServiceProviderBySlug,
} from '../saml/sp-registry.js';
import { evaluateAppLaunch } from '../services/app-access-policy.js';
import {
  enforceCriticalAppMfaOrRedirect,
  getAppMfaBySlug,
  redirectAppMfaStepUp,
  sessionSatisfiesAppMfa,
} from '../services/app-mfa-stepup.js';
import {
  extractRequestIdFromAuthnRequest,
  logSamlAssertion,
  samlBindingFromFlow,
} from '../saml/assertion-log.js';
import { getClientIp, getClientIpDebug } from '../utils/request-context.js';
import { getCachedServerPublicIp } from '../utils/server-public-ip.js';

const router = Router();
const PENDING_SSO_PREFIX = 'lilg:saml:pending:';
const PENDING_SSO_TTL_S  = 300;

function safeReturnPath(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) return '/';
  return path;
}

/** Browser navigations should redirect to login, not return JSON 401. */
async function requireSessionOrLogin(
  req: Request,
  res: Response,
  returnPath: string,
): Promise<boolean> {
  const user = await resolveSession(req, res);
  if (user) {
    req.user = user;
    return true;
  }
  res.redirect(`/login?returnTo=${encodeURIComponent(safeReturnPath(returnPath))}`);
  return false;
}

function samlUnavailable(res: Response): void {
  res.status(503).json({
    error: 'SAML IdP is not configured',
    hint:  'Set SAML_IDP_BASE_URL, SAML_IDP_PRIVATE_KEY_PEM, and SAML_IDP_CERT_PEM',
  });
}

function sendLoginForm(res: Response, html: string): void {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

/** Browser-facing SSO deny page (launch opens in a new tab — JSON 403 is unreadable). */
function sendSsoDeniedPage(
  res: Response,
  opts: { title: string; message: string; detail?: string; code?: string },
): void {
  const detail = opts.detail
    ? `<p style="color:#64748b;font-size:0.9rem;margin:0 0 1.25rem">${escHtml(opts.detail)}</p>`
    : '';
  const code = opts.code
    ? `<p style="color:#94a3b8;font-size:0.75rem;margin:1.5rem 0 0">Code: ${escHtml(opts.code)}</p>`
    : '';
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(opts.title)}</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f1f5f9;color:#0f172a}
  .card{background:#fff;border-radius:12px;padding:2rem 2.25rem;max-width:440px;width:92%;
    box-shadow:0 10px 40px rgba(15,23,42,.08);border:1px solid #e2e8f0}
  h1{font-size:1.15rem;margin:0 0 .75rem} p{line-height:1.5;margin:0 0 1rem;color:#334155}
  a{color:#4f46e5;text-decoration:none;font-weight:600} a:hover{text-decoration:underline}
  .icon{font-size:1.75rem;margin-bottom:.75rem}
</style></head><body>
  <div class="card">
    <div class="icon" aria-hidden="true">🚫</div>
    <h1>${escHtml(opts.title)}</h1>
    <p>${escHtml(opts.message)}</p>
    ${detail}
    <a href="/">← Back to portal</a>
    ${code}
  </div>
</body></html>`;
  res.status(403).setHeader('Content-Type', 'text/html; charset=utf-8').send(html);
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function respondLaunchDenied(
  req: Request,
  res: Response,
  reason: string | undefined,
  clientIp: string,
  appName?: string,
): void {
  if (reason === 'IP_DENIED') {
    const dbg = getClientIpDebug(req);
    const serverIp = getCachedServerPublicIp();
    const missingCf = !dbg.cfConnectingIp;
    const looksLikeOrigin =
      !!serverIp && (clientIp === serverIp || dbg.xForwardedFor === serverIp);
    logger.warn(
      { appName, reason, ...dbg },
      'SSO launch denied by IP allowlist — check proxy client-IP headers',
    );

    let detail =
      `This application can only be opened from allowed network locations.`
      + (appName ? ` (${appName})` : '')
      + (clientIp && clientIp !== 'unknown'
        ? ` Your endpoint public IP: ${clientIp}.`
        : ' Could not determine your endpoint public IP.');
    if (missingCf || looksLikeOrigin) {
      detail +=
        ' Note: Cloudflare CF-Connecting-IP was not seen by the IdP'
        + (looksLikeOrigin ? ' (resolved IP matched the server/origin IP)' : '')
        + '. Proxy headers may be missing — ask an admin to verify TRUST_PROXY and origin forwarding.';
    }

    sendSsoDeniedPage(res, {
      title: 'Application access denied',
      message: 'Unrestricted IP — application access denied.',
      detail,
      code: 'IP_DENIED',
    });
    return;
  }
  sendSsoDeniedPage(res, {
    title: 'Application access denied',
    message: 'You are not entitled to access this application.',
    code: reason ?? 'NO_GRANT',
  });
}

/** Express query/body values → flat string map for Redis replay. */
function normalizeSamlParams(input: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  for (const [key, val] of Object.entries(input)) {
    if (typeof val === 'string') out[key] = val;
    else if (Array.isArray(val) && typeof val[0] === 'string') out[key] = val[0];
  }
  return out;
}

function samlRequestFrom(req: Request): string | undefined {
  return (
    (req.query['SAMLRequest'] as string | undefined) ??
    (req.body?.['SAMLRequest'] as string | undefined)
  );
}

async function resolveSpFromRequest(
  req: Request,
  spEntityIdHint?: string | null,
): Promise<{
  sp: import('../saml/types.js').SamlServiceProviderRow;
} | { error: string; status: number }> {
  if (spEntityIdHint) {
    const sp = await getServiceProviderByEntityId(spEntityIdHint);
    if (sp) return { sp };
  }

  const samlRequest = samlRequestFrom(req);

  if (!samlRequest) {
    return { error: 'Missing SAMLRequest', status: 400 };
  }

  const issuer = extractIssuerFromAuthnRequest(samlRequest);
  if (!issuer) {
    return { error: 'Could not determine Service Provider from SAMLRequest', status: 400 };
  }

  const sp = await getServiceProviderByEntityId(issuer);
  if (!sp) {
    return { error: `Unknown Service Provider: ${issuer}`, status: 404 };
  }

  return { sp };
}

async function issueAssertion(
  req: Request,
  res: Response,
  binding: SamlBinding,
  spEntityIdHint?: string | null,
): Promise<void> {
  if (!isSamlEnabled()) {
    samlUnavailable(res);
    return;
  }

  // /saml/sso is public (SP-initiated) — attach portal session when present so
  // an already-signed-in user is not forced through login/MFA again.
  if (!req.user) {
    const sessionUser = await resolveSession(req, res);
    if (sessionUser) req.user = sessionUser;
  }

  const user = req.user;
  if (!user) {
    const pendingId = uuidv4();
    const query = normalizeSamlParams(req.query as Record<string, unknown>);
    const body  = normalizeSamlParams(req.body as Record<string, unknown>);
    const samlRequest = query['SAMLRequest'] ?? body['SAMLRequest'];
    const spEntityId = samlRequest ? extractIssuerFromAuthnRequest(samlRequest) : null;
    const payload = JSON.stringify({
      binding,
      query,
      body,
      relayState: query['RelayState'] ?? body['RelayState'],
      spEntityId,
    });
    try {
      await redis.set(`${PENDING_SSO_PREFIX}${pendingId}`, payload, 'EX', PENDING_SSO_TTL_S);
    } catch (err) {
      logger.error({ err }, 'Failed to store pending SAML SSO in Redis');
      res.status(503).type('html').send(
        '<!doctype html><title>SSO unavailable</title><h1>Sign-in temporarily unavailable</h1>'
        + '<p>Please retry from the application in a moment.</p>',
      );
      return;
    }
    // Do not pre-encode — Express/res.redirect encodes query values once.
    res.redirect(303, `/login?returnTo=${encodeURIComponent(`/saml/resume/${pendingId}`)}`);
    return;
  }

  const wantsHtml = (req.get('accept') ?? '').includes('text/html');

  const resolved = await resolveSpFromRequest(req, spEntityIdHint);
  if ('error' in resolved) {
    if (wantsHtml) {
      sendSsoDeniedPage(res, {
        title: 'Could not complete SSO',
        message: resolved.error,
        code: `HTTP_${resolved.status}`,
      });
      return;
    }
    res.status(resolved.status).json({ error: resolved.error });
    return;
  }

  const emp = await getEmployeeForSaml(user.empId);
  if (!emp) {
    if (wantsHtml) {
      sendSsoDeniedPage(res, {
        title: 'Could not complete SSO',
        message: 'Employee record not found',
        code: 'EMP_NOT_FOUND',
      });
      return;
    }
    res.status(403).json({ error: 'Employee record not found' });
    return;
  }

  if (!canReceiveSamlAssertion(emp)) {
    if (wantsHtml) {
      sendSsoDeniedPage(res, {
        title: 'SSO not permitted',
        message: 'SSO is not permitted for your account state.',
        code: 'STATE_DENIED',
        detail: `ilg_state=${emp.ilg_state}; hrms_status=${emp.hrms_status}`,
      });
      return;
    }
    res.status(403).json({
      error:       'SSO not permitted for your account state',
      ilg_state:   emp.ilg_state,
      hrms_status: emp.hrms_status,
    });
    return;
  }

  {
    const clientIp = getClientIp(req);
    const decision = await evaluateAppLaunch(
      emp,
      resolved.sp.slug,
      resolved.sp.entitlement_rule,
      { clientIp, enforceIp: true },
    );
    if (!decision.allowed) {
      respondLaunchDenied(req, res, decision.reason, clientIp, resolved.sp.name);
      return;
    }
  }

  {
    const appMfa = await getAppMfaBySlug(resolved.sp.slug);
    if (!(await sessionSatisfiesAppMfa(user.sessionId, appMfa))) {
      // Preserve AuthnRequest across MFA step-up (POST binding would lose the body on redirect).
      const pendingId = uuidv4();
      const q = normalizeSamlParams(req.query as Record<string, unknown>);
      const b = normalizeSamlParams(req.body as Record<string, unknown>);
      try {
        await redis.set(
          `${PENDING_SSO_PREFIX}${pendingId}`,
          JSON.stringify({
            binding,
            query: q,
            body: b,
            relayState: q['RelayState'] ?? b['RelayState'],
            spEntityId: resolved.sp.entity_id,
          }),
          'EX',
          PENDING_SSO_TTL_S,
        );
      } catch (err) {
        logger.error({ err }, 'Failed to store pending SAML SSO for app MFA step-up');
        res.status(503).type('html').send(
          '<!doctype html><title>SSO unavailable</title><h1>Sign-in temporarily unavailable</h1>'
          + '<p>Please retry from the application in a moment.</p>',
        );
        return;
      }
      redirectAppMfaStepUp(res, `/saml/resume/${pendingId}`, appMfa?.name || resolved.sp.name);
      return;
    }
  }

  try {
    const relayState =
      (req.query['RelayState'] as string | undefined) ??
      (req.body?.['RelayState'] as string | undefined) ??
      '';

    const loginInput: import('../saml/idp.js').SamlLoginInput = {
      sp: resolved.sp,
      emp,
      binding,
      relayState,
    };
    if (binding === 'redirect') {
      loginInput.query = req.query as Record<string, string>;
    } else {
      loginInput.body = req.body as Record<string, string>;
    }
    const html = await createSpInitiatedLoginResponse(loginInput);

    const samlRequest =
      (req.query['SAMLRequest'] as string | undefined) ??
      (req.body?.['SAMLRequest'] as string | undefined);
    const logParams = {
      spId:      resolved.sp.id,
      empId:     emp.emp_id,
      binding:   samlBindingFromFlow(binding),
      requestId: extractRequestIdFromAuthnRequest(samlRequest),
    };
    if (relayState) Object.assign(logParams, { relayState });
    await logSamlAssertion(logParams);

    logger.info({ empId: emp.emp_id, sp: resolved.sp.slug }, 'SAML SP-initiated assertion issued');
    sendLoginForm(res, html);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, empId: user.empId, message }, 'SAML assertion failed');
    if (wantsHtml) {
      sendSsoDeniedPage(res, {
        title: 'Could not complete SSO',
        message: 'Failed to issue SAML assertion.',
        detail: message.slice(0, 240),
        code: 'ASSERTION_FAILED',
      });
      return;
    }
    res.status(500).json({ error: 'Failed to issue SAML assertion' });
  }
}

// ---------------------------------------------------------------------------
// IdP metadata (ADMIN+ only — SP onboarding via admin console)
// ---------------------------------------------------------------------------
router.get('/metadata', requireAuth, requireRole('ADMIN'), (_req: Request, res: Response): void => {
  if (!isSamlEnabled()) {
    samlUnavailable(res);
    return;
  }
  res.setHeader('Content-Type', 'application/samlmetadata+xml; charset=utf-8');
  res.send(getIdpMetadataXml());
});

// ---------------------------------------------------------------------------
// SP-initiated SSO
// ---------------------------------------------------------------------------
router.get('/sso', (req, res) => { void issueAssertion(req, res, 'redirect'); });
router.post('/sso', (req, res) => { void issueAssertion(req, res, 'post'); });

// ---------------------------------------------------------------------------
// Resume SSO after portal login (pending AuthnRequest in Redis)
// ---------------------------------------------------------------------------
router.get('/resume/:pendingId', async (req: Request, res: Response): Promise<void> => {
  if (!isSamlEnabled()) {
    samlUnavailable(res);
    return;
  }

  const pendingId = req.params['pendingId'] ?? '';
  if (!(await requireSessionOrLogin(req, res, `/saml/resume/${pendingId}`))) {
    return;
  }

  let raw: string | null;
  try {
    raw = await redis.get(`${PENDING_SSO_PREFIX}${pendingId}`);
  } catch (err) {
    logger.error({ err, pendingId }, 'Redis error loading pending SAML SSO');
    res.status(503).type('html').send(
      '<!doctype html><title>SSO unavailable</title><h1>Sign-in temporarily unavailable</h1>'
      + '<p>Please restart login from the application.</p>',
    );
    return;
  }
  if (!raw) {
    res.status(410).type('html').send(
      '<!doctype html><title>SSO expired</title><h1>SSO session expired</h1>'
      + '<p>Please restart login from the application.</p>',
    );
    return;
  }

  let pending: {
    binding: 'redirect' | 'post';
    query?:  Record<string, string>;
    body?:   Record<string, string>;
    relayState?: string;
    spEntityId?: string | null;
  };
  try {
    pending = JSON.parse(raw) as typeof pending;
  } catch (err) {
    logger.error({ err, pendingId }, 'Corrupt pending SAML SSO payload');
    await redis.del(`${PENDING_SSO_PREFIX}${pendingId}`).catch(() => undefined);
    res.status(500).type('html').send(
      '<!doctype html><title>SSO failed</title><h1>Could not complete SSO</h1>'
      + '<p>Please restart login from the application.</p>',
    );
    return;
  }

  // Critical-app MFA before replaying AuthnRequest (reuse this pending id across step-up).
  {
    const samlReq = pending.query?.['SAMLRequest'] || pending.body?.['SAMLRequest'] || '';
    const issuer = pending.spEntityId
      || (samlReq ? extractIssuerFromAuthnRequest(samlReq) : null);
    const sp = issuer ? await getServiceProviderByEntityId(issuer) : null;
    if (sp && req.user) {
      const appMfa = await getAppMfaBySlug(sp.slug);
      if (!(await sessionSatisfiesAppMfa(req.user.sessionId, appMfa))) {
        redirectAppMfaStepUp(res, `/saml/resume/${pendingId}`, appMfa?.name || sp.name);
        return;
      }
    }
  }

  // Do NOT spread Express req ({...req} drops methods like req.get and breaks samlify).
  // Replay the stored AuthnRequest on the live request, then restore.
  const prevQuery = req.query;
  const prevBody = req.body;
  req.query = pending.query ?? {};
  req.body = pending.body ?? {};

  try {
    await issueAssertion(req, res, pending.binding, pending.spEntityId);
    // Only consume pending SSO after assertion HTML was issued (2xx).
    // Keep the key on 4xx/5xx so a refresh can retry within the TTL.
    if (res.statusCode >= 200 && res.statusCode < 300) {
      await redis.del(`${PENDING_SSO_PREFIX}${pendingId}`).catch(() => undefined);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, pendingId, message }, 'SAML resume assertion failed');
    if (!res.headersSent) {
      res.status(500).type('html').send(
        '<!doctype html><title>SSO failed</title><h1>Could not complete SSO</h1>'
        + `<p>Please restart login from the application.</p>`
        + `<p style="color:#666;font-size:13px">${escHtml(message).slice(0, 240)}</p>`,
      );
    }
  } finally {
    req.query = prevQuery;
    req.body = prevBody;
  }
});

// ---------------------------------------------------------------------------
// IdP-initiated SSO (user clicks app tile in portal)
// ---------------------------------------------------------------------------
router.get('/launch/:slug', async (req: Request, res: Response): Promise<void> => {
  if (!isSamlEnabled()) {
    samlUnavailable(res);
    return;
  }

  const slug = req.params['slug'] ?? '';
  if (!(await requireSessionOrLogin(req, res, `/saml/launch/${slug}`))) {
    return;
  }

  const user = req.user!;
  const sp = await getServiceProviderBySlug(slug);
  if (!sp) {
    res.status(404).json({ error: 'Application not found' });
    return;
  }

  const emp = await getEmployeeForSaml(user.empId);
  if (!emp) {
    res.status(403).json({ error: 'Employee record not found' });
    return;
  }

  if (!canReceiveSamlAssertion(emp)) {
    res.status(403).json({ error: 'SSO not permitted for your account state' });
    return;
  }

  {
    const clientIp = getClientIp(req);
    const decision = await evaluateAppLaunch(
      emp,
      sp.slug,
      sp.entitlement_rule,
      { clientIp, enforceIp: true },
    );
    if (!decision.allowed) {
      respondLaunchDenied(req, res, decision.reason, clientIp, sp.name);
      return;
    }
  }

  {
    const appMfa = await getAppMfaBySlug(sp.slug);
    const ok = await enforceCriticalAppMfaOrRedirect(req, res, {
      sessionId: user.sessionId,
      returnPath: `/saml/launch/${slug}`,
      app: appMfa,
    });
    if (!ok) return;
  }

  try {
    const relayState = resolveSamlRelayState(
      sp.default_relay_state,
      req.query['RelayState'] as string | undefined,
    );
    const html = await createIdpInitiatedLoginResponse(sp, emp, relayState);

    const logParams = {
      spId:    sp.id,
      empId:   emp.emp_id,
      binding: 'IDP_INITIATED' as const,
    };
    if (relayState) Object.assign(logParams, { relayState });
    await logSamlAssertion(logParams);

    logger.info({ empId: emp.emp_id, sp: sp.slug }, 'SAML IdP-initiated assertion issued');
    sendLoginForm(res, html);
  } catch (err) {
    logger.error({ err }, 'SAML IdP-initiated launch failed');
    res.status(500).json({ error: 'Failed to launch application' });
  }
});

export default router;
