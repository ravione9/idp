/**
 * Admin — App Discovery (shadow IT from real browser / manual signals)
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { requireRole, requirePortalModule } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import {
  deleteDiscoveredApp,
  getDiscoveryStats,
  listDiscoveredApps,
  promoteDiscoveredApp,
  runDiscoveryScan,
  updateDiscoveredApp,
  upsertDiscoveredApp,
} from '../services/app-discovery.js';

const router = Router();
router.use(requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), requirePortalModule('applications'));

router.get(
  '/stats',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await getDiscoveryStats());
  }),
);

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const opts: {
      status?: string;
      source?: string;
      q?: string;
      limit?: number;
      offset?: number;
    } = {
      limit: parseInt(String(req.query['limit'] ?? '100'), 10),
      offset: parseInt(String(req.query['offset'] ?? '0'), 10),
    };
    const status = String(req.query['status'] ?? '').trim();
    const source = String(req.query['source'] ?? '').trim();
    const q = String(req.query['q'] ?? '').trim();
    if (status) opts.status = status;
    if (source) opts.source = source;
    if (q) opts.q = q;
    const result = await listDiscoveredApps(opts);
    res.json(result);
  }),
);

const createSchema = z.object({
  name: z.string().min(1).max(200),
  domain: z.string().min(3).max(255),
  category: z.string().max(80).optional().nullable(),
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN']).optional(),
  notes: z.string().max(2000).optional().nullable(),
});

router.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
      return;
    }
    const r = await upsertDiscoveredApp({
      name: parsed.data.name,
      domain: parsed.data.domain,
      category: parsed.data.category ?? null,
      source: 'MANUAL',
      riskLevel: parsed.data.riskLevel ?? 'UNKNOWN',
      notes: parsed.data.notes ?? null,
      createdBy: req.user!.empId,
    });
    res.status(r.created ? 201 : 200).json(r);
  }),
);

router.post(
  '/scan',
  asyncHandler(async (req: Request, res: Response) => {
    const result = await runDiscoveryScan(req.user!.empId);
    res.json({ success: true, ...result });
  }),
);

const patchSchema = z.object({
  status: z.enum(['NEW', 'REVIEWING', 'SANCTIONED', 'IGNORED']).optional(),
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN']).optional(),
  notes: z.string().max(2000).optional().nullable(),
  name: z.string().min(1).max(200).optional(),
  category: z.string().max(80).optional().nullable(),
});

router.patch(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
      return;
    }
    try {
      const patch: {
        status?: 'NEW' | 'REVIEWING' | 'SANCTIONED' | 'IGNORED';
        riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
        notes?: string | null;
        name?: string;
        category?: string | null;
      } = {};
      if (parsed.data.status !== undefined) patch.status = parsed.data.status;
      if (parsed.data.riskLevel !== undefined) patch.riskLevel = parsed.data.riskLevel;
      if (parsed.data.notes !== undefined) patch.notes = parsed.data.notes;
      if (parsed.data.name !== undefined) patch.name = parsed.data.name;
      if (parsed.data.category !== undefined) patch.category = parsed.data.category;
      await updateDiscoveredApp(req.params['id']!, patch);
      res.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Update failed';
      res.status(msg.includes('not found') ? 404 : 400).json({ error: msg });
    }
  }),
);

router.post(
  '/:id/promote',
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const result = await promoteDiscoveredApp(req.params['id']!, req.user!.empId);
      res.json({ success: true, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Promote failed';
      res.status(msg.includes('not found') ? 404 : 400).json({ error: msg });
    }
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    try {
      await deleteDiscoveredApp(req.params['id']!);
      res.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Delete failed';
      res.status(msg.includes('not found') ? 404 : 400).json({ error: msg });
    }
  }),
);

export default router;
