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
import { requireAuth } from '../auth/middleware.js';
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
import {
  getEmployeeForSaml,
  getServiceProviderByEntityId,
  getServiceProviderBySlug,
} from '../saml/sp-registry.js';
import { evaluateEntitlement } from '../saml/entitlements.js';

const router = Router();
const PENDING_SSO_PREFIX = 'lilg:saml:pending:';
const PENDING_SSO_TTL_S  = 300;

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

async function resolveSpFromRequest(req: Request): Promise<{
  sp: import('../saml/types.js').SamlServiceProviderRow;
} | { error: string; status: number }> {
  const samlRequest =
    (req.query['SAMLRequest'] as string | undefined) ??
    (req.body?.['SAMLRequest'] as string | undefined);

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
): Promise<void> {
  if (!isSamlEnabled()) {
    samlUnavailable(res);
    return;
  }

  const user = req.user;
  if (!user) {
    const pendingId = uuidv4();
    const payload = JSON.stringify({
      binding,
      query:  req.query,
      body:   req.body,
      relayState: (req.query['RelayState'] ?? req.body?.['RelayState']) as string | undefined,
    });
    await redis.set(`${PENDING_SSO_PREFIX}${pendingId}`, payload, 'EX', PENDING_SSO_TTL_S);
    const returnTo = encodeURIComponent(`/saml/resume/${pendingId}`);
    res.redirect(`/auth/google?returnTo=${returnTo}`);
    return;
  }

  const resolved = await resolveSpFromRequest(req);
  if ('error' in resolved) {
    res.status(resolved.status).json({ error: resolved.error });
    return;
  }

  const emp = await getEmployeeForSaml(user.empId);
  if (!emp) {
    res.status(403).json({ error: 'Employee record not found' });
    return;
  }

  if (!canReceiveSamlAssertion(emp)) {
    res.status(403).json({
      error:       'SSO not permitted for your account state',
      ilg_state:   emp.ilg_state,
      hrms_status: emp.hrms_status,
    });
    return;
  }

  if (!evaluateEntitlement(emp, resolved.sp.entitlement_rule)) {
    res.status(403).json({ error: 'You are not entitled to access this application' });
    return;
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

    logger.info({ empId: emp.emp_id, sp: resolved.sp.slug }, 'SAML SP-initiated assertion issued');
    sendLoginForm(res, html);
  } catch (err) {
    logger.error({ err, empId: user.empId }, 'SAML assertion failed');
    res.status(500).json({ error: 'Failed to issue SAML assertion' });
  }
}

// ---------------------------------------------------------------------------
// IdP metadata (public — SP admins use this to configure trust)
// ---------------------------------------------------------------------------
router.get('/metadata', (_req: Request, res: Response): void => {
  if (!isSamlEnabled()) {
    samlUnavailable(res);
    return;
  }
  res.setHeader('Content-Type', 'application/xml');
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
router.get('/resume/:pendingId', requireAuth, async (req: Request, res: Response): Promise<void> => {
  if (!isSamlEnabled()) {
    samlUnavailable(res);
    return;
  }

  const raw = await redis.get(`${PENDING_SSO_PREFIX}${req.params['pendingId']}`);
  if (!raw) {
    res.status(410).json({ error: 'SSO session expired; restart login from the application' });
    return;
  }

  await redis.del(`${PENDING_SSO_PREFIX}${req.params['pendingId']}`);

  const pending = JSON.parse(raw) as {
    binding: 'redirect' | 'post';
    query?:  Record<string, string>;
    body?:   Record<string, string>;
    relayState?: string;
  };

  const fakeReq = {
    ...req,
    query: pending.query ?? {},
    body:  pending.body ?? {},
    user:  req.user,
  } as Request;

  await issueAssertion(fakeReq, res, pending.binding);
});

// ---------------------------------------------------------------------------
// IdP-initiated SSO (user clicks app tile in portal)
// ---------------------------------------------------------------------------
router.get('/launch/:slug', requireAuth, async (req: Request, res: Response): Promise<void> => {
  if (!isSamlEnabled()) {
    samlUnavailable(res);
    return;
  }

  const user = req.user!;
  const sp = await getServiceProviderBySlug(req.params['slug'] ?? '');
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

  if (!evaluateEntitlement(emp, sp.entitlement_rule)) {
    res.status(403).json({ error: 'You are not entitled to access this application' });
    return;
  }

  try {
    const relayState = (req.query['RelayState'] as string | undefined) ?? '';
    const html = await createIdpInitiatedLoginResponse(sp, emp, relayState);
    logger.info({ empId: emp.emp_id, sp: sp.slug }, 'SAML IdP-initiated assertion issued');
    sendLoginForm(res, html);
  } catch (err) {
    logger.error({ err }, 'SAML IdP-initiated launch failed');
    res.status(500).json({ error: 'Failed to launch application' });
  }
});

export default router;
