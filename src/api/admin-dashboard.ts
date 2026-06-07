/**
 * Admin dashboard — aggregate stats and time-series for the IdP console.
 *
 * Two endpoints:
 *   GET /          — KPI tiles, ILG-state breakdown, system status, recent SSO
 *   GET /timeseries — login + SSO trend data for charts (last 30 days)
 *   GET /sessions   — sessions insight (active / expired / revoked) for donut
 */
import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { requireRole } from '../auth/rbac.js';
import { queryOne } from '../db/connection.js';
import { safeQuery } from '../db/safe-query.js';
import { asyncHandler } from '../utils/async-handler.js';
import { config, isSamlEnabled } from '../config.js';
import { getGoogleOidcConfig, isGoogleOidcConfigured } from '../auth/google-oidc-config.js';

const router = Router();

router.use(requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'));

router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const [
    employees,
    activeEmployees,
    localAdmins,
    samlApps,
    activeSamlApps,
    sessions,
    assertions24h,
    assertions7d,
    pendingApprovals,
    pendingReviews,
    openSodViolations,
    mfaEnrolled,
  ] = await Promise.all([
    queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM employees', []).catch(() => ({ n: 0 })),
    queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM employees WHERE ilg_state IN ('ACTIVE','REACTIVATED')", []).catch(() => ({ n: 0 })),
    queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM local_accounts WHERE active = 1', []).catch(() => ({ n: 0 })),
    queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM saml_service_providers', []).catch(() => ({ n: 0 })),
    queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM saml_service_providers WHERE active = 1', []).catch(() => ({ n: 0 })),
    queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM idp_sessions WHERE expires_at > UTC_TIMESTAMP() AND revoked_at IS NULL', []).catch(() => ({ n: 0 })),
    queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM saml_assertion_log WHERE ts > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)', []).catch(() => ({ n: 0 })),
    queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM saml_assertion_log WHERE ts > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)', []).catch(() => ({ n: 0 })),
    queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM access_request_approvals WHERE decision = 'PENDING'", []).catch(() => ({ n: 0 })),
    queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM access_review_items WHERE decision = 'PENDING'", []).catch(() => ({ n: 0 })),
    queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM sod_violations WHERE status = 'OPEN'", []).catch(() => ({ n: 0 })),
    queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM mfa_secrets WHERE enabled = 1', []).catch(() => ({ n: 0 })),
  ]);

  const recentAssertions = await safeQuery<{ ts: string; emp_id: string; sp_name: string; binding: string }>(
    `SELECT al.ts, al.emp_id, sp.name AS sp_name, al.binding
       FROM saml_assertion_log al
       JOIN saml_service_providers sp ON sp.id = al.sp_id
      ORDER BY al.ts DESC
      LIMIT 10`,
    [],
  );

  const ilgStateRows = await safeQuery<{ ilg_state: string; n: number }>(
    'SELECT ilg_state, COUNT(*) AS n FROM employees GROUP BY ilg_state',
    [],
  );

  const topApps = await safeQuery<{ slug: string; name: string; n: number }>(
    `SELECT sp.slug, sp.name, COUNT(*) AS n
       FROM saml_assertion_log al
       JOIN saml_service_providers sp ON sp.id = al.sp_id
      WHERE al.ts > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)
      GROUP BY sp.id, sp.slug, sp.name
      ORDER BY n DESC
      LIMIT 5`,
    [],
  );

  const base = config.app.publicBaseUrl ?? config.saml?.baseUrl;
  const googleOidc = await getGoogleOidcConfig();

  res.json({
    counts: {
      employees:        employees?.n ?? 0,
      activeEmployees:  activeEmployees?.n ?? 0,
      localAdmins:      localAdmins?.n ?? 0,
      samlApps:         samlApps?.n ?? 0,
      activeSamlApps:   activeSamlApps?.n ?? 0,
      activeSessions:   sessions?.n ?? 0,
      assertions24h:    assertions24h?.n ?? 0,
      assertions7d:     assertions7d?.n ?? 0,
      pendingApprovals: pendingApprovals?.n ?? 0,
      pendingReviews:   pendingReviews?.n ?? 0,
      openSodViolations: openSodViolations?.n ?? 0,
      mfaEnrolled:      mfaEnrolled?.n ?? 0,
    },
    ilgStates:        ilgStateRows,
    recentAssertions,
    topApps,
    system: {
      samlEnabled:        isSamlEnabled(),
      publicBaseUrl:      base ?? null,
      metadataUrl:        base ? `${base}/saml/metadata` : null,
      googleConfigured:   isGoogleOidcConfigured(googleOidc),
      zohoSamlConfigured: false,
    },
  });
}));

router.get('/timeseries', asyncHandler(async (_req: Request, res: Response) => {
  const logins = await safeQuery<{ d: string; n: number }>(
    `SELECT DATE(ts) AS d, COUNT(*) AS n
       FROM auth_attempts
      WHERE success = 1
        AND ts > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)
      GROUP BY DATE(ts)
      ORDER BY d ASC`,
    [],
  );
  const ssos = await safeQuery<{ d: string; n: number }>(
    `SELECT DATE(ts) AS d, COUNT(*) AS n
       FROM saml_assertion_log
      WHERE ts > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)
      GROUP BY DATE(ts)
      ORDER BY d ASC`,
    [],
  );
  res.json({ logins, ssos });
}));

router.get('/sessions-insight', asyncHandler(async (_req: Request, res: Response) => {
  const [active, expired, revoked] = await Promise.all([
    queryOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM idp_sessions WHERE expires_at > UTC_TIMESTAMP() AND revoked_at IS NULL',
      [],
    ).catch(() => ({ n: 0 })),
    queryOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM idp_sessions WHERE expires_at <= UTC_TIMESTAMP() AND revoked_at IS NULL',
      [],
    ).catch(() => ({ n: 0 })),
    queryOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM idp_sessions WHERE revoked_at IS NOT NULL',
      [],
    ).catch(() => ({ n: 0 })),
  ]);
  res.json({
    active:  active?.n ?? 0,
    expired: expired?.n ?? 0,
    revoked: revoked?.n ?? 0,
  });
}));

export default router;
