/**
 * Config — Birthright Rules API
 * Mounted at /api/admin/birthright
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../auth/middleware.js';
import { requireRole } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import { query, execute } from '../db/connection.js';
import { assignBirthrightEntitlements } from '../services/birthright.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('ADMIN', 'SUPER_ADMIN'));

// GET / — list is_birthright entitlements with app name
router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await query(
    `SELECT ent.*, a.name AS app_name
     FROM entitlements ent
     LEFT JOIN applications a ON a.id = ent.app_id
     WHERE ent.is_birthright = 1
     ORDER BY ent.name`,
    [],
  );
  res.json({ data: rows });
}));

// POST / — create birthright entitlement
router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const { name, description, app_id, type = 'ROLE', scope, risk_score = 0 } = req.body as {
    name: string; description?: string; app_id?: string;
    type?: string; scope?: string; risk_score?: number;
  };
  if (!name) { res.status(400).json({ error: 'name required' }); return; }
  const id = uuidv4();
  const empId = (req as unknown as { user?: { empId?: string } }).user?.empId ?? null;
  await execute(
    `INSERT INTO entitlements
       (id, name, description, app_id, type, scope, risk_score,
        is_birthright, active, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?)`,
    [id, name, description ?? null, app_id ?? null, type, scope ?? null, risk_score, empId],
  );
  res.status(201).json({ id });
}));

// PUT /:id
router.put('/:id', asyncHandler(async (req: Request, res: Response) => {
  const { name, is_birthright, scope, active } = req.body as {
    name?: string; is_birthright?: number; scope?: string; active?: number;
  };
  await execute(
    `UPDATE entitlements SET
       name = COALESCE(?, name),
       is_birthright = COALESCE(?, is_birthright),
       scope = COALESCE(?, scope),
       active = COALESCE(?, active)
     WHERE id = ?`,
    [name ?? null, is_birthright ?? null, scope ?? null, active ?? null, req.params['id']],
  );
  res.json({ success: true });
}));

// GET /dry-run — simulate who would get what
router.get('/dry-run', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await query(
    `SELECT e.emp_id, e.full_name, e.department,
       COUNT(ent.id) AS would_get_count
     FROM employees e
     CROSS JOIN entitlements ent WHERE ent.is_birthright=1 AND ent.active=1
     LEFT JOIN user_entitlements ue ON ue.emp_id=e.emp_id
       AND ue.entitlement_id=ent.id AND ue.revoked_at IS NULL
     WHERE e.ilg_state='ACTIVE' AND ue.id IS NULL
     GROUP BY e.emp_id
     LIMIT 50`,
    [],
  );
  res.json({ data: rows });
}));

// POST /run — actually run birthright assignment for all active employees (SUPER_ADMIN only)
router.post('/run', requireRole('SUPER_ADMIN'), asyncHandler(async (_req: Request, res: Response) => {
  // Fetch all active employees and run birthright for each
  const employees = await query<{ emp_id: string; department: string; employment_type: string }>(
    `SELECT emp_id, COALESCE(department, '') AS department, COALESCE(employment_type, '') AS employment_type
     FROM employees WHERE ilg_state = 'ACTIVE'`,
    [],
  );
  let totalAssigned = 0;
  for (const emp of employees) {
    const count = await assignBirthrightEntitlements(emp.emp_id, emp.department, emp.employment_type);
    totalAssigned += count;
  }
  res.json({ success: true, assigned: totalAssigned, employees: employees.length });
}));

export default router;
