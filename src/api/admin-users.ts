/**
 * Admin users — unified employee + local-account list for IdP console
 */
import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { requireRole } from '../auth/rbac.js';
import { query, queryOne } from '../db/connection.js';

const router = Router();

router.use(requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'));

router.get('/', async (req: Request, res: Response): Promise<void> => {
  const limit  = Math.min(parseInt((req.query['limit']  as string) ?? '100', 10), 500);
  const offset = parseInt((req.query['offset'] as string) ?? '0', 10);
  const search = (req.query['q'] as string)?.trim() ?? '';
  const state  = (req.query['state'] as string) ?? '';

  const where: string[] = [];
  const params: unknown[] = [];

  if (search) {
    where.push('(e.full_name LIKE ? OR e.email_corp LIKE ? OR e.emp_id LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  if (state) {
    where.push('e.ilg_state = ?');
    params.push(state);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await query<Record<string, unknown>>(
    `SELECT e.emp_id, e.full_name, e.email_corp, e.role AS hrms_role,
            e.employment_type, e.hrms_status, e.ilg_state, e.ilg_state_since,
            e.dept_id, e.manager_emp_id, e.hire_date,
            la.role AS admin_role, la.last_login_at, la.active AS admin_active
       FROM employees e
       LEFT JOIN local_accounts la ON la.emp_id = e.emp_id AND la.active = 1
       ${whereSql}
      ORDER BY e.full_name ASC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  const total = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM employees e ${whereSql}`,
    params,
  );

  res.json({ data: rows, total: total?.n ?? 0, limit, offset });
});

export default router;
