/**
 * Config — Business Roles API
 * Mounted at /api/admin/business-roles
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../auth/middleware.js';
import { requireRole } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import { query, execute } from '../db/connection.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('ADMIN', 'SUPER_ADMIN'));

// GET /
router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await query(
    `SELECT br.*, COUNT(re.id) AS entitlement_count
     FROM business_roles br
     LEFT JOIN role_entitlements re ON re.role_id = br.id
     GROUP BY br.id
     ORDER BY br.name`,
    [],
  );
  res.json({ data: rows });
}));

// POST /
router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const { name, description, parent_role_id, risk_score = 0 } = req.body as {
    name: string; description?: string; parent_role_id?: string; risk_score?: number;
  };
  if (!name) { res.status(400).json({ error: 'name required' }); return; }
  const id = uuidv4();
  await execute(
    `INSERT INTO business_roles (id, name, description, parent_role_id, risk_score)
     VALUES (?, ?, ?, ?, ?)`,
    [id, name, description ?? null, parent_role_id ?? null, risk_score],
  );
  res.status(201).json({ id });
}));

// PUT /:id
router.put('/:id', asyncHandler(async (req: Request, res: Response) => {
  const { name, description, risk_score, active } = req.body as {
    name?: string; description?: string; risk_score?: number; active?: number;
  };
  await execute(
    `UPDATE business_roles SET
       name = COALESCE(?, name),
       description = COALESCE(?, description),
       risk_score = COALESCE(?, risk_score),
       active = COALESCE(?, active)
     WHERE id = ?`,
    [name ?? null, description ?? null, risk_score ?? null, active ?? null, req.params['id']],
  );
  res.json({ success: true });
}));

// DELETE /:id — soft delete
router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  await execute(`UPDATE business_roles SET active=0 WHERE id=?`, [req.params['id']]);
  res.json({ success: true });
}));

// GET /:id/entitlements
router.get('/:id/entitlements', asyncHandler(async (req: Request, res: Response) => {
  const rows = await query(
    `SELECT re.*, ent.name AS entitlement_name, ent.type AS entitlement_type
     FROM role_entitlements re
     JOIN entitlements ent ON ent.id = re.entitlement_id
     WHERE re.role_id = ?`,
    [req.params['id']],
  );
  res.json({ data: rows });
}));

// POST /:id/entitlements
router.post('/:id/entitlements', asyncHandler(async (req: Request, res: Response) => {
  const { entitlementId } = req.body as { entitlementId: string };
  if (!entitlementId) { res.status(400).json({ error: 'entitlementId required' }); return; }
  const id = uuidv4();
  await execute(
    `INSERT IGNORE INTO role_entitlements (id, role_id, entitlement_id) VALUES (?, ?, ?)`,
    [id, req.params['id'], entitlementId],
  );
  res.status(201).json({ success: true });
}));

// DELETE /:id/entitlements/:entId
router.delete('/:id/entitlements/:entId', asyncHandler(async (req: Request, res: Response) => {
  await execute(
    `DELETE FROM role_entitlements WHERE role_id=? AND entitlement_id=?`,
    [req.params['id'], req.params['entId']],
  );
  res.json({ success: true });
}));

export default router;
