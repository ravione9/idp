/**
 * Config — Adaptive Auth Policies API
 * Mounted at /api/admin/adaptive-auth
 *
 * Supported condition types (stored in conditions_json):
 *   IP_RANGE        { type, values: string[] }                        CIDR/prefix list
 *   NETWORK_TYPE    { type, values: ('CORPORATE'|'EXTERNAL'|'TOR'|'PROXY')[] }
 *   DEVICE_MANAGED  { type, value: 'true'|'false' }
 *   NEW_DEVICE      { type }
 *   IMPOSSIBLE_TRAVEL { type }
 *   COUNTRY         { type, op: 'in'|'not_in', values: string[] }     ISO-3166 alpha-2
 *   USER_ROLE       { type, values: string[] }
 *   RISK_SCORE      { type, op: 'gt'|'gte'|'lt'|'lte', value: number }
 *   SENSITIVE_APP   { type }
 *   TOR_PROXY       { type }
 *
 * Actions: ALLOW | MFA | STEP_UP | DENY | BLOCK
 * Priority: lower number = evaluated first; highest-severity match wins.
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../auth/middleware.js';
import { requireRole } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import { query, execute } from '../db/connection.js';
import { evaluateAdaptiveAuth } from '../services/adaptive-auth-engine.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('ADMIN', 'SUPER_ADMIN'));

// GET /
router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await query(
    `SELECT * FROM adaptive_auth_policies ORDER BY priority ASC`, [],
  );
  res.json({ data: rows });
}));

// POST /
router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const { name, description, priority = 100, conditions_json, action = 'MFA', scope = 'ALL', app_ids_json, group_ids_json } = req.body as {
    name: string; description?: string; priority?: number;
    conditions_json: unknown[]; action?: string; scope?: string;
    app_ids_json?: unknown[]; group_ids_json?: unknown[];
  };
  if (!name) { res.status(400).json({ error: 'name required' }); return; }
  if (!conditions_json) { res.status(400).json({ error: 'conditions_json required' }); return; }
  const id = uuidv4();
  const empId = (req as unknown as { user?: { empId?: string } }).user?.empId ?? null;
  await execute(
    `INSERT INTO adaptive_auth_policies
       (id, name, description, priority, conditions_json, action, scope, app_ids_json, group_ids_json, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, description ?? null, priority, JSON.stringify(conditions_json),
     action, scope,
     app_ids_json ? JSON.stringify(app_ids_json) : null,
     group_ids_json ? JSON.stringify(group_ids_json) : null,
     empId],
  );
  res.status(201).json({ id });
}));

// PUT /:id
router.put('/:id', asyncHandler(async (req: Request, res: Response) => {
  const { name, description, priority, conditions_json, action, scope, active } = req.body as {
    name?: string; description?: string; priority?: number;
    conditions_json?: unknown[]; action?: string; scope?: string; active?: number;
  };
  await execute(
    `UPDATE adaptive_auth_policies SET
       name = COALESCE(?, name),
       description = COALESCE(?, description),
       priority = COALESCE(?, priority),
       conditions_json = COALESCE(?, conditions_json),
       action = COALESCE(?, action),
       scope = COALESCE(?, scope),
       active = COALESCE(?, active),
       updated_at = UTC_TIMESTAMP()
     WHERE id = ?`,
    [name ?? null, description ?? null, priority ?? null,
     conditions_json ? JSON.stringify(conditions_json) : null,
     action ?? null, scope ?? null, active ?? null, req.params['id']],
  );
  res.json({ success: true });
}));

// DELETE /:id — hard delete
router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  await execute(`DELETE FROM adaptive_auth_policies WHERE id = ?`, [req.params['id']]);
  res.json({ success: true });
}));

// POST /evaluate — test policy against a simulated login context
router.post('/evaluate', asyncHandler(async (req: Request, res: Response) => {
  const { ip, email, userAgent, appId, empId, role } = req.body as {
    ip?: string; email?: string; userAgent?: string;
    appId?: string; empId?: string; role?: string;
  };

  if (!empId) { res.status(400).json({ error: 'empId required for evaluation' }); return; }

  const result = await evaluateAdaptiveAuth({
    ip:        ip        ?? '127.0.0.1',
    email:     email     ?? '',
    userAgent: userAgent ?? '',
    role:      role      ?? 'EMPLOYEE',
    empId,
    ...(appId !== undefined && { appId }),
  });

  res.json({
    input:           { ip, email, userAgent, appId, empId, role },
    decision:        result.action,
    riskScore:       result.riskScore,
    signals:         result.signals,
    matchedPolicies: result.matchedPolicies,
  });
}));

export default router;
