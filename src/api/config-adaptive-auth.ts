/**
 * Config — Adaptive Auth Policies API
 * Mounted at /api/admin/adaptive-auth
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../auth/middleware.js';
import { requireRole } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import { query, execute } from '../db/connection.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('SUPER_ADMIN'));

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

// POST /evaluate — test policy against sample context
router.post('/evaluate', asyncHandler(async (req: Request, res: Response) => {
  const { ip, email, userAgent, appId } = req.body as {
    ip?: string; email?: string; userAgent?: string; appId?: string;
  };

  const policies = await query<{
    id: string; name: string; priority: number;
    conditions_json: string; action: string; scope: string;
    app_ids_json: string | null; group_ids_json: string | null; active: number;
  }>(
    `SELECT * FROM adaptive_auth_policies WHERE active=1 ORDER BY priority ASC`, [],
  );

  const matched: { id: string; name: string; action: string }[] = [];
  let finalAction = 'ALLOW';

  for (const policy of policies) {
    const conditions: { type: string; values?: string[]; value?: string }[] =
      typeof policy.conditions_json === 'string'
        ? JSON.parse(policy.conditions_json)
        : (policy.conditions_json as unknown as { type: string }[]);

    let matches = true;
    for (const cond of conditions) {
      if (cond.type === 'IP_RANGE' && ip) {
        // Simple prefix check for now
        const allowed = (cond.values ?? []).some((cidr: string) => ip.startsWith(cidr.split('/')[0].split('.').slice(0, 2).join('.')));
        if (!allowed) matches = false;
      }
    }

    if (policy.scope === 'APP_SPECIFIC' && appId) {
      const ids: string[] = policy.app_ids_json ? JSON.parse(policy.app_ids_json) : [];
      if (!ids.includes(appId)) matches = false;
    }

    if (matches) {
      matched.push({ id: policy.id, name: policy.name, action: policy.action });
      // Higher priority action wins (BLOCK > DENY > MFA > ALLOW)
      const rank: Record<string, number> = { ALLOW: 0, MFA: 1, DENY: 2, BLOCK: 3 };
      if ((rank[policy.action] ?? 0) > (rank[finalAction] ?? 0)) {
        finalAction = policy.action;
      }
    }
  }

  res.json({ input: { ip, email, userAgent, appId }, matchedPolicies: matched, decision: finalAction });
}));

export default router;
