/**
 * Portal console roles — list built-ins + CRUD custom roles with module R/W.
 * Mounted at /api/admin/portal-roles
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { requirePortalModule, requireRole } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import {
  PORTAL_MODULES,
  createCustomRole,
  deleteCustomRole,
  getRolePermissions,
  listPortalRoles,
  updateCustomRole,
} from '../services/portal-roles.js';

const router = Router();
router.use(requireAuth);
router.use(requirePortalModule('administrators'));

const permSchema = z.object({
  moduleKey: z.string().min(1),
  canRead: z.boolean(),
  canWrite: z.boolean(),
});

router.get('/modules', asyncHandler(async (_req: Request, res: Response) => {
  res.json({
    data: PORTAL_MODULES,
    note: 'Privileged Access (PAM) is not available yet and is not assignable.',
  });
}));

router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const roles = await listPortalRoles(true);
  const data = await Promise.all(roles.map(async (r) => ({
    ...r,
    permissions: await getRolePermissions(r.id),
  })));
  res.json({ data });
}));

router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
  const roles = await listPortalRoles(true);
  const role = roles.find((r) => r.id === req.params['id']);
  if (!role) { res.status(404).json({ error: 'Role not found' }); return; }
  res.json({ ...role, permissions: await getRolePermissions(role.id) });
}));

router.post('/', requireRole('SUPER_ADMIN'), asyncHandler(async (req: Request, res: Response) => {
  const schema = z.object({
    name: z.string().min(2).max(128),
    description: z.string().max(512).optional(),
    permissions: z.array(permSchema).min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  const id = await createCustomRole({
    name: parsed.data.name,
    description: parsed.data.description ?? '',
    permissions: parsed.data.permissions,
    createdBy: req.user!.empId,
  });
  res.status(201).json({ id });
}));

router.put('/:id', requireRole('SUPER_ADMIN'), asyncHandler(async (req: Request, res: Response) => {
  const schema = z.object({
    name: z.string().min(2).max(128).optional(),
    description: z.string().max(512).optional().nullable(),
    active: z.boolean().optional(),
    permissions: z.array(permSchema).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  try {
    const patch: {
      name?: string;
      description?: string;
      active?: boolean;
      permissions?: Array<{ moduleKey: string; canRead: boolean; canWrite: boolean }>;
    } = {};
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.description !== undefined) patch.description = parsed.data.description ?? '';
    if (parsed.data.active !== undefined) patch.active = parsed.data.active;
    if (parsed.data.permissions) {
      patch.permissions = parsed.data.permissions.map((p) => ({
        moduleKey: p.moduleKey,
        canRead: p.canRead,
        canWrite: p.canWrite,
      }));
    }
    await updateCustomRole(req.params['id']!, patch);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Update failed' });
  }
}));

router.delete('/:id', requireRole('SUPER_ADMIN'), asyncHandler(async (req: Request, res: Response) => {
  try {
    await deleteCustomRole(req.params['id']!);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Delete failed' });
  }
}));

export default router;
