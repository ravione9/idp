/**
 * Config — General Settings API
 * Mounted at /api/admin/general-settings
 */
import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { requireRole } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import { queryOne, execute } from '../db/connection.js';
import { getGoogleOidcConfig, isGoogleOidcConfigured } from '../auth/google-oidc-config.js';
import { parseGoogleHostedDomains } from '../auth/google-domains.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('SUPER_ADMIN'));

// GET /
router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const row = await queryOne(`SELECT * FROM general_settings WHERE id = 1`, []);
  res.json(row ?? { id: 1 });
}));

function readString(body: Record<string, unknown>, key: string): string | undefined {
  const raw = body[key];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

function parseGoogleOauthClientJson(rawJson: string): { clientId: string; clientSecret: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error('Invalid JSON. Paste the OAuth client JSON downloaded from Google Cloud Console.');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('OAuth JSON is invalid. Expected an object with a "web" section.');
  }

  const root = parsed as Record<string, unknown>;
  const web = (root['web'] && typeof root['web'] === 'object')
    ? (root['web'] as Record<string, unknown>)
    : root;

  const clientId = typeof web['client_id'] === 'string' ? web['client_id'].trim() : '';
  const clientSecret = typeof web['client_secret'] === 'string' ? web['client_secret'].trim() : '';

  if (!clientId || !clientSecret) {
    throw new Error('OAuth JSON must include web.client_id and web.client_secret.');
  }

  return { clientId, clientSecret };
}

router.get('/google-oidc', asyncHandler(async (_req: Request, res: Response) => {
  const cfg = await getGoogleOidcConfig();
  res.json({
    clientId: cfg.clientId,
    hostedDomain: cfg.hostedDomain,
    hostedDomains: cfg.hostedDomains,
    hasClientSecret: Boolean(cfg.clientSecret),
    source: cfg.source,
    configured: isGoogleOidcConfigured(cfg),
  });
}));

router.put('/google-oidc', asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const oauthJson = readString(body, 'oauthClientJson');
  let jsonCreds: { clientId: string; clientSecret: string } | null = null;
  if (oauthJson) {
    jsonCreds = parseGoogleOauthClientJson(oauthJson);
  }

  const existing = await getGoogleOidcConfig();
  const clientId = readString(body, 'clientId') ?? jsonCreds?.clientId ?? existing.clientId;
  const clientSecret = readString(body, 'clientSecret') ?? jsonCreds?.clientSecret ?? existing.clientSecret;
  const hostedDomainRaw = readString(body, 'hostedDomain')
    ?? (existing.hostedDomains.length ? existing.hostedDomains.join('\n') : existing.hostedDomain);
  const hostedDomains = parseGoogleHostedDomains(hostedDomainRaw);
  const hostedDomainStored = hostedDomains.join('\n');

  if (!clientId || !clientSecret || !hostedDomains.length) {
    res.status(400).json({
      error: 'clientId, clientSecret, and at least one hosted domain are required (directly or from OAuth JSON).',
    });
    return;
  }

  const empId = (req as unknown as { user?: { empId?: string } }).user?.empId ?? null;
  await execute(
    `INSERT INTO general_settings
       (id, google_oidc_client_id, google_oidc_client_secret, google_oidc_hosted_domain, updated_by, updated_at)
     VALUES (1, ?, ?, ?, ?, UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE
       google_oidc_client_id = VALUES(google_oidc_client_id),
       google_oidc_client_secret = VALUES(google_oidc_client_secret),
       google_oidc_hosted_domain = VALUES(google_oidc_hosted_domain),
       updated_by = VALUES(updated_by),
       updated_at = UTC_TIMESTAMP()`,
    [clientId, clientSecret, hostedDomainStored, empId],
  );

  res.json({
    success: true,
    configured: isGoogleOidcConfigured({ clientId, clientSecret, hostedDomains }),
  });
}));

// PUT /
router.put('/', asyncHandler(async (req: Request, res: Response) => {
  const {
    display_name, support_email, default_session_hours,
    session_absolute_hours, password_min_length, mfa_grace_period_days,
    audit_retention_days, allow_google_login, allow_local_login,
    maintenance_mode, maintenance_msg,
  } = req.body as Record<string, unknown>;
  const empId = (req as unknown as { user?: { empId?: string } }).user?.empId ?? null;

  await execute(
    `INSERT INTO general_settings
       (id, display_name, support_email, default_session_hours,
        session_absolute_hours, password_min_length, mfa_grace_period_days,
        audit_retention_days, allow_google_login, allow_local_login,
        maintenance_mode, maintenance_msg, updated_by, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE
       display_name = VALUES(display_name),
       support_email = VALUES(support_email),
       default_session_hours = VALUES(default_session_hours),
       session_absolute_hours = VALUES(session_absolute_hours),
       password_min_length = VALUES(password_min_length),
       mfa_grace_period_days = VALUES(mfa_grace_period_days),
       audit_retention_days = VALUES(audit_retention_days),
       allow_google_login = VALUES(allow_google_login),
       allow_local_login = VALUES(allow_local_login),
       maintenance_mode = VALUES(maintenance_mode),
       maintenance_msg = VALUES(maintenance_msg),
       updated_by = VALUES(updated_by),
       updated_at = UTC_TIMESTAMP()`,
    [display_name ?? 'Lenskart IdP', support_email ?? null,
     default_session_hours ?? 8, session_absolute_hours ?? 24,
     password_min_length ?? 10, mfa_grace_period_days ?? 14,
     audit_retention_days ?? 365,
     allow_google_login !== undefined ? (allow_google_login ? 1 : 0) : 1,
     allow_local_login !== undefined ? (allow_local_login ? 1 : 0) : 1,
     maintenance_mode ? 1 : 0, maintenance_msg ?? null, empId],
  );
  res.json({ success: true });
}));

export default router;
