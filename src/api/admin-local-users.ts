/**
 * Admin Central — manage local administrator accounts
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { requireRole, type Role } from '../auth/rbac.js';
import { config } from '../config.js';
import {
  countLocalAdmins,
  createLocalAdministrator,
  deactivateLocalAdmin,
  listLocalAdmins,
} from '../services/local-admin.js';
import logger from '../utils/logger.js';

const router = Router();

// ---------------------------------------------------------------------------
// GET /status — public; used by login page to show bootstrap form
// ---------------------------------------------------------------------------
router.get('/status', async (_req: Request, res: Response): Promise<void> => {
  const count = await countLocalAdmins();
  res.json({
    localAdminCount: count,
    bootstrapEnabled: count === 0 && Boolean(config.app.localBootstrapToken),
  });
});

const createSchema = z.object({
  fullName: z.string().min(1).max(255),
  email:    z.string().email(),
  password: z.string().min(10).max(128),
  role:     z.enum(['ADMIN', 'SUPER_ADMIN']),
});

const bootstrapSchema = z.object({
  fullName: z.string().min(1).max(255),
  email:    z.string().email(),
  password: z.string().min(10).max(128),
  token:    z.string().min(8),
});

// ---------------------------------------------------------------------------
// POST /bootstrap — first local super admin (only when none exist)
// ---------------------------------------------------------------------------
router.post('/bootstrap', async (req: Request, res: Response): Promise<void> => {
  const bootstrapToken = config.app.localBootstrapToken;
  if (!bootstrapToken) {
    res.status(403).json({ error: 'Bootstrap is disabled' });
    return;
  }

  const parsed = bootstrapSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }

  if (parsed.data.token !== bootstrapToken) {
    res.status(403).json({ error: 'Invalid bootstrap token' });
    return;
  }

  const count = await countLocalAdmins();
  if (count > 0) {
    res.status(409).json({ error: 'Bootstrap already completed — local admins exist' });
    return;
  }

  try {
    const created = await createLocalAdministrator({
      fullName:  parsed.data.fullName,
      email:     parsed.data.email,
      password:  parsed.data.password,
      role:      'SUPER_ADMIN',
      createdBy: 'BOOTSTRAP',
    });

    logger.info({ email: created.email }, 'Bootstrap super admin created');
    res.status(201).json({ success: true, ...created });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Bootstrap failed';
    res.status(400).json({ error: msg });
  }
});

// ---------------------------------------------------------------------------
// GET / — list local administrators
// ---------------------------------------------------------------------------
router.get(
  '/',
  requireAuth,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (_req: Request, res: Response): Promise<void> => {
    const data = await listLocalAdmins();
    res.json({ data });
  },
);

// ---------------------------------------------------------------------------
// POST / — create local administrator
// ---------------------------------------------------------------------------
router.post(
  '/',
  requireAuth,
  requireRole('SUPER_ADMIN'),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
      return;
    }

    try {
      const created = await createLocalAdministrator({
        fullName:  parsed.data.fullName,
        email:     parsed.data.email,
        password:  parsed.data.password,
        role:      parsed.data.role as Role,
        createdBy: req.user!.empId,
      });

      logger.info({ createdBy: req.user!.empId, email: created.email }, 'Local admin created');
      res.status(201).json({ success: true, ...created });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Create failed';
      res.status(400).json({ error: msg });
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /:id — deactivate local administrator
// ---------------------------------------------------------------------------
router.delete(
  '/:id',
  requireAuth,
  requireRole('SUPER_ADMIN'),
  async (req: Request, res: Response): Promise<void> => {
    const id = parseInt(req.params['id'] ?? '', 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }

    try {
      await deactivateLocalAdmin(id, req.user!.empId);
      res.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Deactivate failed';
      res.status(400).json({ error: msg });
    }
  },
);

export default router;
