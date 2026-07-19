/**
 * Config — SSO Reports API
 * Mounted at /api/admin/sso-reports
 */
import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { requireRole, requirePortalModule } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import { query, queryOne } from '../db/connection.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('ADMIN', 'SUPER_ADMIN'), requirePortalModule('reports'));

// GET /login-summary — SSO assertions per application (last 30 days)
router.get('/login-summary', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await query(
    `SELECT sp.name AS app, COUNT(al.id) AS count
     FROM saml_service_providers sp
     LEFT JOIN saml_assertion_log al ON al.sp_id = sp.id
       AND al.ts > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)
     WHERE sp.active = 1
     GROUP BY sp.id, sp.name
     ORDER BY count DESC`,
    [],
  );
  res.json({ data: rows });
}));

// GET /failed-logins — failed portal login attempts by email
router.get('/failed-logins', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await query(
    `SELECT email, COUNT(*) AS count, MAX(ts) AS last_attempt
     FROM auth_attempts
     WHERE success = 0 AND ts > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)
     GROUP BY email
     ORDER BY count DESC
     LIMIT 100`,
    [],
  );
  res.json({ data: rows });
}));

// GET /app-adoption — entitled vs signed-in users per SAML app
router.get('/app-adoption', asyncHandler(async (_req: Request, res: Response) => {
  const entitledRow = await queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM employees WHERE ilg_state = 'ACTIVE'",
    [],
  );
  const entitled = entitledRow?.n ?? 0;

  const rows = await query<{ app: string; signed_in: number }>(
    `SELECT sp.name AS app, COUNT(DISTINCT al.emp_id) AS signed_in
     FROM saml_service_providers sp
     LEFT JOIN saml_assertion_log al ON al.sp_id = sp.id
       AND al.ts > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)
     WHERE sp.active = 1
     GROUP BY sp.id, sp.name
     ORDER BY signed_in DESC`,
    [],
  );

  res.json({
    data: rows.map((row) => ({
      app:          row.app,
      entitled,
      signed_in:    Number(row.signed_in) || 0,
      adoption_pct: entitled > 0 ? Math.round((Number(row.signed_in) / entitled) * 100) : 0,
    })),
  });
}));

// GET /dormant-users — active employees with no recent portal session
router.get('/dormant-users', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await query(
    `SELECT e.email_corp AS email, MAX(s.last_active_at) AS last_login
     FROM employees e
     LEFT JOIN idp_sessions s ON s.emp_id = e.emp_id
     WHERE e.ilg_state = 'ACTIVE'
     GROUP BY e.emp_id, e.email_corp
     HAVING last_login IS NULL OR last_login < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)
     ORDER BY last_login ASC
     LIMIT 100`,
    [],
  );
  res.json({ data: rows });
}));

export default router;
