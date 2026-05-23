/**
 * Admin audit log — combined view of SAML assertions + tamper-evident audit_log
 */
import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { requireRole } from '../auth/rbac.js';
import { query } from '../db/connection.js';

const router = Router();

router.use(requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'));

router.get('/saml', async (req: Request, res: Response): Promise<void> => {
  const limit = Math.min(parseInt((req.query['limit'] as string) ?? '100', 10), 500);
  const rows = await query<Record<string, unknown>>(
    `SELECT al.id, al.ts, al.emp_id, al.binding, al.relay_state, al.request_id,
            sp.name AS sp_name, sp.slug AS sp_slug,
            e.full_name AS emp_name, e.email_corp AS emp_email
       FROM saml_assertion_log al
       JOIN saml_service_providers sp ON sp.id = al.sp_id
       LEFT JOIN employees e ON e.emp_id = al.emp_id
      ORDER BY al.ts DESC
      LIMIT ?`,
    [limit],
  ).catch(() => []);
  res.json({ data: rows });
});

router.get('/system', async (req: Request, res: Response): Promise<void> => {
  const limit = Math.min(parseInt((req.query['limit'] as string) ?? '100', 10), 500);
  const rows = await query<Record<string, unknown>>(
    `SELECT id, ts, actor, action, target, payload
       FROM audit_log
      ORDER BY ts DESC
      LIMIT ?`,
    [limit],
  ).catch(() => []);
  res.json({ data: rows });
});

export default router;
