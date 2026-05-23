/**
 * Config — Identity Profiles API
 * Mounted at /api/admin/identity-profiles
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
  const rows = await query(`SELECT * FROM identity_profiles ORDER BY name`, []);
  res.json({ data: rows });
}));

// POST /
router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const { name, description, population = 'EMPLOYEE', source_system, attribute_map_json, birthright_rule } = req.body as {
    name: string; description?: string; population?: string;
    source_system?: string; attribute_map_json?: unknown; birthright_rule?: string;
  };
  if (!name) { res.status(400).json({ error: 'name required' }); return; }
  const id = uuidv4();
  const empId = (req as unknown as { user?: { empId?: string } }).user?.empId ?? null;
  await execute(
    `INSERT INTO identity_profiles
       (id, name, description, population, source_system, attribute_map_json, birthright_rule, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, description ?? null, population, source_system ?? null,
     attribute_map_json ? JSON.stringify(attribute_map_json) : null,
     birthright_rule ?? null, empId],
  );
  res.status(201).json({ id });
}));

// PUT /:id
router.put('/:id', asyncHandler(async (req: Request, res: Response) => {
  const { name, description, population, source_system, birthright_rule, active } = req.body as {
    name?: string; description?: string; population?: string;
    source_system?: string; birthright_rule?: string; active?: number;
  };
  await execute(
    `UPDATE identity_profiles SET
       name = COALESCE(?, name),
       description = COALESCE(?, description),
       population = COALESCE(?, population),
       source_system = COALESCE(?, source_system),
       birthright_rule = COALESCE(?, birthright_rule),
       active = COALESCE(?, active),
       updated_at = UTC_TIMESTAMP()
     WHERE id = ?`,
    [name ?? null, description ?? null, population ?? null,
     source_system ?? null, birthright_rule ?? null, active ?? null, req.params['id']],
  );
  res.json({ success: true });
}));

// DELETE /:id — soft delete
router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  await execute(
    `UPDATE identity_profiles SET active = 0, updated_at = UTC_TIMESTAMP() WHERE id = ?`,
    [req.params['id']],
  );
  res.json({ success: true });
}));

export default router;
