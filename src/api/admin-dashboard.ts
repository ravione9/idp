/**
 * Admin dashboard — aggregate stats for the IdP console
 */
import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { requireRole } from '../auth/rbac.js';
import { query, queryOne } from '../db/connection.js';
import { config, isSamlEnabled } from '../config.js';

const router = Router();

router.use(requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'));

router.get('/', async (_req: Request, res: Response): Promise<void> => {
  const [
    employees,
    activeEmployees,
    localAdmins,
    samlApps,
    activeSamlApps,
    sessions,
    assertions24h,
    assertions7d,
    recentAssertions,
  ] = await Promise.all([
    queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM employees', []),
    queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM employees WHERE ilg_state IN ('ACTIVE','REACTIVATED')", []),
    queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM local_accounts WHERE active = 1', []),
    queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM saml_service_providers', []),
    queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM saml_service_providers WHERE active = 1', []),
    queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM lilg_sessions WHERE expires_at > UTC_TIMESTAMP() AND revoked_at IS NULL', []),
    queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM saml_assertion_log WHERE ts > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)', []).catch(() => ({ n: 0 })),
    queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM saml_assertion_log WHERE ts > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)', []).catch(() => ({ n: 0 })),
    query<{ ts: string; emp_id: string; sp_name: string; binding: string }>(
      `SELECT al.ts, al.emp_id, sp.name AS sp_name, al.binding
         FROM saml_assertion_log al
         JOIN saml_service_providers sp ON sp.id = al.sp_id
        ORDER BY al.ts DESC
        LIMIT 10`,
      [],
    ).catch(() => []),
  ]);

  const ilgStateRows = await query<{ ilg_state: string; n: number }>(
    'SELECT ilg_state, COUNT(*) AS n FROM employees GROUP BY ilg_state',
    [],
  ).catch(() => []);

  const base = config.app.publicBaseUrl ?? config.saml?.baseUrl;

  res.json({
    counts: {
      employees:       employees?.n ?? 0,
      activeEmployees: activeEmployees?.n ?? 0,
      localAdmins:     localAdmins?.n ?? 0,
      samlApps:        samlApps?.n ?? 0,
      activeSamlApps:  activeSamlApps?.n ?? 0,
      activeSessions:  sessions?.n ?? 0,
      assertions24h:   assertions24h?.n ?? 0,
      assertions7d:    assertions7d?.n ?? 0,
    },
    ilgStates:    ilgStateRows,
    recentAssertions,
    system: {
      samlEnabled:  isSamlEnabled(),
      publicBaseUrl: base ?? null,
      metadataUrl:  base ? `${base}/saml/metadata` : null,
      googleConfigured: !config.google.clientId.startsWith('REPLACE_ME'),
      zohoSamlConfigured: false, // populated once the seeded Zoho Mail SAML app is registered & keys are in place
    },
  });
});

export default router;
