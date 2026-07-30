/**
 * Admin Central — manage local administrator accounts
 */

import { timingSafeEqual } from 'node:crypto';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { requireRole } from '../auth/rbac.js';
import { config } from '../config.js';
import {
  countLocalAdmins,
  createLocalAdministrator,
  deactivateLocalAdmin,
  listLocalAdmins,
} from '../services/local-admin.js';
import logger from '../utils/logger.js';

const router = Router();

const createSchema = z.object({
  fullName: z.string().min(1).max(255),
  email:    z.string().email(),
  password: z.string().min(10).max(128),
  /** portal role id or system key */
  role:     z.string().min(1),
});

const bootstrapSchema = z.object({
  fullName: z.string().min(1).max(255),
  email:    z.string().email(),
  password: z.string().min(10).max(128),
  token:    z.string().min(8),
});

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Public bootstrap probe for the login page — only returns a boolean,
 * never the local-admin count (IDP-01).
 */
export async function bootstrapStatusHandler(_req: Request, res: Response): Promise<void> {
  const count = await countLocalAdmins();
  res.json({
    bootstrapEnabled: count === 0 && Boolean(config.app.localBootstrapToken),
  });
}

/** First-time SUPER_ADMIN creation — gated by LOCAL_BOOTSTRAP_TOKEN. */
export async function bootstrapAdminHandler(req: Request, res: Response): Promise<void> {
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

  if (!tokenMatches(parsed.data.token, bootstrapToken)) {
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
}

// All remaining routes require SUPER_ADMIN session.
router.use(requireAuth, requireRole('SUPER_ADMIN'));

// ---------------------------------------------------------------------------
// GET /status — authenticated admin diagnostics (count + bootstrap flag)
// ---------------------------------------------------------------------------
router.get('/status', async (_req: Request, res: Response): Promise<void> => {
  const count = await countLocalAdmins();
  res.json({
    localAdminCount: count,
    bootstrapEnabled: count === 0 && Boolean(config.app.localBootstrapToken),
  });
});

// ---------------------------------------------------------------------------
// GET / — list local administrators
// ---------------------------------------------------------------------------
router.get(
  '/',
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
        role:      parsed.data.role,
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
