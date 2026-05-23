import { Router, Request, Response } from 'express';
import { query, queryOne } from '../db/connection.js';
import { requireAuth } from '../auth/middleware.js';
import { requireRole, getEmployeeScope } from '../auth/rbac.js';
import { policyEngine } from '../abac/policy-engine.js';

const router = Router();

// ---------------------------------------------------------------------------
// GET /employees — list with scope + pagination
// ---------------------------------------------------------------------------
router.get(
  '/',
  requireAuth,
  requireRole('MANAGER', 'HRBP', 'ADMIN', 'SUPER_ADMIN'),
  async (req: Request, res: Response): Promise<void> => {
    const limit  = Math.min(parseInt((req.query['limit']  as string) ?? '50', 10), 200);
    const offset = parseInt((req.query['offset'] as string) ?? '0', 10);

    const scope = getEmployeeScope(req);

    const rows = await query<{
      emp_id: string;
      full_name: string;
      email_corp: string;
      dept_id: string;
      role: string;
      employment_type: string;
      hrms_status: string;
      ilg_state: string;
      ilg_state_since: string;
      hire_date: string;
    }>(
      `SELECT e.emp_id, e.full_name, e.email_corp, e.dept_id, e.role,
              e.employment_type, e.hrms_status, e.ilg_state, e.ilg_state_since, e.hire_date
         FROM employees e
        WHERE ${scope.sql}
        ORDER BY e.full_name ASC
        LIMIT ? OFFSET ?`,
      [...scope.params, limit, offset],
    );

    const [{ total }] = await query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM employees e WHERE ${scope.sql}`,
      scope.params,
    );

    res.json({ data: rows, total, limit, offset });
  },
);

// ---------------------------------------------------------------------------
// GET /employees/:empId — single employee with ABAC
// ---------------------------------------------------------------------------
router.get(
  '/:empId',
  requireAuth,
  policyEngine.requireAbac((req) => ({
    type:  'EMPLOYEE_RECORD',
    empId: req.params['empId'],
  })),
  async (req: Request, res: Response): Promise<void> => {
    const { empId } = req.params;

    const employee = await queryOne<Record<string, unknown>>(
      `SELECT e.*,
              m.full_name AS manager_full_name,
              m.email_corp AS manager_email
         FROM employees e
         LEFT JOIN employees m ON m.emp_id = e.manager_emp_id
        WHERE e.emp_id = ?`,
      [empId],
    );

    if (!employee) {
      res.status(404).json({ error: 'Employee not found' });
      return;
    }

    // Scope check — non-admin users may only access within their scope
    const scope = getEmployeeScope(req);
    if (scope.sql !== '1=1') {
      const [{ allowed }] = await query<{ allowed: number }>(
        `SELECT COUNT(*) AS allowed FROM employees e WHERE e.emp_id = ? AND (${scope.sql})`,
        [empId, ...scope.params],
      );
      if (!allowed) {
        res.status(403).json({ error: 'Outside your management scope' });
        return;
      }
    }

    res.json(employee);
  },
);

// ---------------------------------------------------------------------------
// GET /employees/:empId/state-history
// ---------------------------------------------------------------------------
router.get(
  '/:empId/state-history',
  requireAuth,
  requireRole('MANAGER', 'HRBP', 'ADMIN', 'SUPER_ADMIN'),
  async (req: Request, res: Response): Promise<void> => {
    const { empId } = req.params;
    const limit  = Math.min(parseInt((req.query['limit']  as string) ?? '50', 10), 200);
    const offset = parseInt((req.query['offset'] as string) ?? '0', 10);

    const rows = await query<Record<string, unknown>>(
      `SELECT id, from_state, to_state, reason_code, evidence, actor, actor_id, origin, ts, workflow_run_id
         FROM state_transitions
        WHERE emp_id = ?
        ORDER BY ts DESC
        LIMIT ? OFFSET ?`,
      [empId, limit, offset],
    );

    const [{ total }] = await query<{ total: number }>(
      'SELECT COUNT(*) AS total FROM state_transitions WHERE emp_id = ?',
      [empId],
    );

    res.json({ data: rows, total, limit, offset });
  },
);

// ---------------------------------------------------------------------------
// GET /employees/:empId/identity-links
// ---------------------------------------------------------------------------
router.get(
  '/:empId/identity-links',
  requireAuth,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (req: Request, res: Response): Promise<void> => {
    const { empId } = req.params;

    const links = await query<Record<string, unknown>>(
      `SELECT id, system, external_id, status, last_synced_at, drift_flag, auth_kind
         FROM identity_links
        WHERE emp_id = ?
        ORDER BY system ASC`,
      [empId],
    );

    res.json({ data: links });
  },
);

// ---------------------------------------------------------------------------
// GET /employees/:empId/role-bindings
// ---------------------------------------------------------------------------
router.get(
  '/:empId/role-bindings',
  requireAuth,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (req: Request, res: Response): Promise<void> => {
    const { empId } = req.params;

    const bindings = await query<Record<string, unknown>>(
      `SELECT id, system, scope, role_name, granted_at, revoked_at, snapshot_ts
         FROM role_bindings
        WHERE emp_id = ?
        ORDER BY granted_at DESC`,
      [empId],
    );

    res.json({ data: bindings });
  },
);

export default router;
