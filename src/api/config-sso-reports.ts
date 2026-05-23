/**
 * Config — SSO Reports API
 * Mounted at /api/admin/sso-reports
 */
import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { requireRole } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import { query } from '../db/connection.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('ADMIN', 'SUPER_ADMIN'));

// GET /login-summary
router.get('/login-summary', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await query(
    `SELECT DATE(created_at) AS day, iss AS method, COUNT(*) AS n
     FROM idp_sessions
     WHERE created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)
     GROUP BY DATE(created_at), iss
     ORDER BY day ASC`,
    [],
  );
  res.json({ data: rows });
}));

// GET /failed-logins
router.get('/failed-logins', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await query(
    `SELECT DATE(ts) AS day, reason, COUNT(*) AS n
     FROM auth_attempts
     WHERE success=0 AND ts > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)
     GROUP BY DATE(ts), reason
     ORDER BY day ASC`,
    [],
  );
  res.json({ data: rows });
}));

// GET /app-adoption
router.get('/app-adoption', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await query(
    `SELECT sp.name, sp.slug, COUNT(al.id) AS assertions,
       COUNT(DISTINCT al.emp_id) AS unique_users
     FROM saml_service_providers sp
     LEFT JOIN saml_assertion_log al ON al.sp_id = sp.id
       AND al.ts > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)
     WHERE sp.active=1
     GROUP BY sp.id
     ORDER BY assertions DESC`,
    [],
  );
  res.json({ data: rows });
}));

// GET /dormant-users
router.get('/dormant-users', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await query(
    `SELECT e.emp_id, e.full_name, e.email_corp, e.department,
       MAX(s.last_active_at) AS last_login
     FROM employees e
     LEFT JOIN idp_sessions s ON s.emp_id = e.emp_id
     WHERE e.ilg_state = 'ACTIVE'
     GROUP BY e.emp_id
     HAVING last_login IS NULL OR last_login < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)
     ORDER BY last_login ASC
     LIMIT 100`,
    [],
  );
  res.json({ data: rows });
}));

export default router;
