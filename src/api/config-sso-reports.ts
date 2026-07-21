/**
 * Config — SSO Reports API
 * Mounted at /api/admin/sso-reports
 * Supports days / from / to query params (default last 30 days).
 */
import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { requireRole, requirePortalModule } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import { query, queryOne } from '../db/connection.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('ADMIN', 'SUPER_ADMIN'), requirePortalModule('reports'));

function parseWindow(req: Request): { from: string; to: string | null; days: number } {
  const daysRaw = parseInt(String(req.query['days'] ?? '30'), 10);
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 365) : 30;

  let from = typeof req.query['from'] === 'string' ? req.query['from'].trim() : '';
  let to = typeof req.query['to'] === 'string' ? req.query['to'].trim() : '';

  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) from = `${from} 00:00:00`;
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) to = `${to} 23:59:59`;

  if (!from) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - days);
    from = d.toISOString().slice(0, 19).replace('T', ' ');
  }

  return { from, to: to || null, days };
}

// GET /login-summary — SSO assertions per application
router.get('/login-summary', asyncHandler(async (req: Request, res: Response) => {
  const { from, to, days } = parseWindow(req);
  const toSql = to ? 'AND al.ts <= ?' : '';
  const params = to ? [from, to] : [from];

  const rows = await query(
    `SELECT sp.name AS app, COUNT(al.id) AS count
     FROM saml_service_providers sp
     LEFT JOIN saml_assertion_log al ON al.sp_id = sp.id
       AND al.ts >= ? ${toSql}
     WHERE sp.active = 1
     GROUP BY sp.id, sp.name
     ORDER BY count DESC`,
    params,
  );
  res.json({ data: rows, meta: { from, to, days } });
}));

// GET /failed-logins — failed portal login attempts by email
router.get('/failed-logins', asyncHandler(async (req: Request, res: Response) => {
  const { from, to, days } = parseWindow(req);
  const toSql = to ? 'AND ts <= ?' : '';
  const params = to ? [from, to] : [from];

  const rows = await query(
    `SELECT email, COUNT(*) AS count, MAX(ts) AS last_attempt
     FROM auth_attempts
     WHERE success = 0 AND ts >= ? ${toSql}
     GROUP BY email
     ORDER BY count DESC
     LIMIT 200`,
    params,
  );
  res.json({ data: rows, meta: { from, to, days } });
}));

// GET /app-adoption — entitled vs signed-in users per SAML app
router.get('/app-adoption', asyncHandler(async (req: Request, res: Response) => {
  const { from, to, days } = parseWindow(req);
  const toSql = to ? 'AND al.ts <= ?' : '';
  const params = to ? [from, to] : [from];

  const entitledRow = await queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM employees WHERE ilg_state = 'ACTIVE'",
    [],
  );
  const entitled = entitledRow?.n ?? 0;

  const rows = await query<{ app: string; signed_in: number }>(
    `SELECT sp.name AS app, COUNT(DISTINCT al.emp_id) AS signed_in
     FROM saml_service_providers sp
     LEFT JOIN saml_assertion_log al ON al.sp_id = sp.id
       AND al.ts >= ? ${toSql}
     WHERE sp.active = 1
     GROUP BY sp.id, sp.name
     ORDER BY signed_in DESC`,
    params,
  );

  res.json({
    data: rows.map((row) => ({
      app:          row.app,
      entitled,
      signed_in:    Number(row.signed_in) || 0,
      adoption_pct: entitled > 0 ? Math.round((Number(row.signed_in) / entitled) * 100) : 0,
    })),
    meta: { from, to, days },
  });
}));

// GET /dormant-users — active employees with no recent portal session
router.get('/dormant-users', asyncHandler(async (req: Request, res: Response) => {
  const { from, to, days } = parseWindow(req);
  // Dormant = last activity before window start (or never)
  const rows = await query(
    `SELECT e.email_corp AS email, MAX(s.last_active_at) AS last_login
     FROM employees e
     LEFT JOIN idp_sessions s ON s.emp_id = e.emp_id
     WHERE e.ilg_state = 'ACTIVE'
     GROUP BY e.emp_id, e.email_corp
     HAVING last_login IS NULL OR last_login < ?
     ORDER BY last_login ASC
     LIMIT 200`,
    [from],
  );
  res.json({ data: rows, meta: { from, to, days } });
}));

export default router;
