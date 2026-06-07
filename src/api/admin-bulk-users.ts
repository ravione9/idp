/**
 * Admin — Bulk User Import API
 * Mounted at /api/admin/bulk-users
 *
 * POST /batch — process a chunk of user rows (max 500 per request).
 * Clients upload up to 100,000 rows by sending multiple batch requests.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { requireRole } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import { processBulkUserBatch } from '../services/bulk-user-import.js';
import logger from '../utils/logger.js';

const router = Router();
router.use(requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'));

export const BULK_BATCH_MAX = 500;
export const BULK_TOTAL_MAX = 100_000;

const rowSchema = z.object({
  line:            z.number().int().positive().optional(),
  email:           z.string().email().max(255),
  fullName:        z.string().min(2).max(255),
  empId:           z.string().max(20).optional(),
  deptId:          z.string().max(50).optional(),
  employmentType:  z.string().max(20).optional(),
  ilgState:        z.string().max(30).optional(),
  managerEmpId:    z.string().max(20).optional(),
  groups:          z.array(z.string().min(1).max(200)).max(50).optional(),
});

const batchSchema = z.object({
  mode: z.enum(['upsert', 'create', 'update']).default('upsert'),
  rows: z.array(rowSchema).min(1).max(BULK_BATCH_MAX),
});

router.post('/batch', asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const parsed = batchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }

  const adminId = (req as unknown as { user?: { empId?: string } }).user?.empId ?? null;
  const { mode, rows } = parsed.data;

  const started = Date.now();
  const result = await processBulkUserBatch(rows, mode, adminId);

  logger.info(
    {
      mode,
      rowCount: rows.length,
      created: result.created,
      updated: result.updated,
      failed: result.failed,
      groupsAdded: result.groupsAdded,
      durationMs: Date.now() - started,
      adminId,
    },
    'Bulk user batch processed',
  );

  res.json({
    success: result.failed === 0,
    mode,
    limits: { batchMax: BULK_BATCH_MAX, totalMax: BULK_TOTAL_MAX },
    ...result,
  });
}));

export default router;
