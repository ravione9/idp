/**
 * Admin — Bulk User Import API
 * Mounted at /api/admin/bulk-users
 *
 * GET  /template          — CSV template download
 * POST /validate          — dry-run validation + preview
 * POST /batch             — process a chunk (max 500)
 * POST /import            — alias of /batch with report-friendly response
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { requireRole, requirePortalModule } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import {
  bulkTemplateCsv,
  processBulkUserBatch,
  validateBulkUserRows,
  type BulkUserRowInput,
} from '../services/bulk-user-import.js';
import { appendAuditLog } from '../utils/audit-log.js';
import logger from '../utils/logger.js';

const router = Router();
router.use(requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), requirePortalModule('identity_users'));

export const BULK_BATCH_MAX = 500;
export const BULK_TOTAL_MAX = 100_000;

const rowSchema = z.object({
  line:            z.number().int().positive().optional(),
  email:           z.string().min(1).max(255),
  fullName:        z.string().max(255).optional(),
  firstName:       z.string().max(100).optional(),
  lastName:        z.string().max(100).optional(),
  employeeId:      z.string().max(64).optional(),
  empId:           z.string().max(64).optional(),
  department:      z.string().max(100).optional(),
  deptId:          z.string().max(100).optional(),
  designation:     z.string().max(200).optional(),
  username:        z.string().max(100).optional(),
  status:          z.string().max(30).optional(),
  ilgState:        z.string().max(30).optional(),
  manager:         z.string().max(255).optional(),
  managerEmpId:    z.string().max(20).optional(),
  mobile:          z.string().max(40).optional(),
  location:        z.string().max(200).optional(),
  costCenter:      z.string().max(80).optional(),
  employeeType:    z.string().max(20).optional(),
  employmentType:  z.string().max(20).optional(),
  joiningDate:     z.string().max(32).optional(),
  businessRole:    z.string().max(120).optional(),
  groups:          z.array(z.string().min(1).max(200)).max(50).optional(),
});

const batchSchema = z.object({
  mode: z.enum(['upsert', 'create', 'update']).default('upsert'),
  rows: z.array(rowSchema).min(1).max(BULK_BATCH_MAX),
});

router.get('/template', asyncHandler(async (req: Request, res: Response) => {
  const format = String(req.query['format'] ?? 'csv').toLowerCase();
  const csv = bulkTemplateCsv();
  if (format === 'xlsx') {
    // Provide CSV with .csv content-type; Excel opens it. True XLSX needs client-side SheetJS.
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="bulk-users-template.csv"');
    res.send(csv);
    return;
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="bulk-users-template.csv"');
  res.send(csv);
}));

router.post('/validate', asyncHandler(async (req: Request, res: Response) => {
  const parsed = z.object({ rows: z.array(rowSchema).min(1).max(BULK_BATCH_MAX) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }
  const result = await validateBulkUserRows(parsed.data.rows as BulkUserRowInput[]);
  res.json(result);
}));

async function runBatch(req: Request, res: Response): Promise<void> {
  const parsed = batchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }

  const adminId = (req as unknown as { user?: { empId?: string } }).user?.empId ?? null;
  const { mode, rows } = parsed.data;

  const started = Date.now();
  const result = await processBulkUserBatch(rows as BulkUserRowInput[], mode, adminId);

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

  await appendAuditLog(adminId ?? 'system', 'BULK_USER_IMPORT', 'employees', {
    mode,
    processed: result.processed,
    created: result.created,
    updated: result.updated,
    failed: result.failed,
  });

  const reportCsv = [
    'line,email,emp_id,action,error,code',
    ...result.rows.map((r) =>
      [r.line ?? '', r.email, r.empId ?? '', r.action, JSON.stringify(r.error ?? ''), r.code ?? ''].join(','),
    ),
  ].join('\n');

  res.json({
    success: result.failed === 0,
    mode,
    limits: { batchMax: BULK_BATCH_MAX, totalMax: BULK_TOTAL_MAX },
    totalRecords: result.processed,
    imported: result.created,
    updated: result.updated,
    skipped: result.skipped,
    failed: result.failed,
    groupsAdded: result.groupsAdded,
    durationMs: Date.now() - started,
    rows: result.rows,
    reportCsv,
  });
}

router.post('/batch', asyncHandler(runBatch));
router.post('/import', asyncHandler(runBatch));

export default router;
