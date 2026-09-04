/**
 * Admin — Bulk Password Update API
 * Mounted at /api/admin/bulk-passwords
 *
 * GET  /template  — CSV template download (email, new_password)
 * POST /validate  — dry-run validation + preview
 * POST /batch     — process a chunk (max 500)
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { requireRole, requirePortalModule } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import {
  bulkPasswordTemplateCsv,
  findDuplicateEmailsInBatch,
  findDuplicateEmpIdsInBatch,
  processBulkPasswordBatch,
  validateBulkPasswordRows,
  type BulkPasswordRowInput,
} from '../services/bulk-password-update.js';
import { appendAuditLog } from '../utils/audit-log.js';
import logger from '../utils/logger.js';

const router = Router();
router.use(requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), requirePortalModule('identity_users'));

export const BULK_PASSWORD_BATCH_MAX = 500;
export const BULK_PASSWORD_TOTAL_MAX = 10_000;

const rowSchema = z.object({
  line:         z.number().int().positive().optional(),
  email:        z.string().max(255).optional(),
  empId:        z.string().max(64).optional(),
  employeeId:   z.string().max(64).optional(),
  newPassword:  z.string().min(1).max(256),
});

router.get('/template', asyncHandler(async (_req: Request, res: Response) => {
  const csv = bulkPasswordTemplateCsv();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="bulk-password-update-template.csv"');
  res.send(csv);
}));

router.post('/validate', asyncHandler(async (req: Request, res: Response) => {
  const parsed = z.object({
    rows: z.array(rowSchema).min(1).max(BULK_PASSWORD_BATCH_MAX),
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }

  const rows = parsed.data.rows as BulkPasswordRowInput[];
  const dupEmails = await findDuplicateEmailsInBatch(rows);
  const dupEmpIds = await findDuplicateEmpIdsInBatch(rows);
  const result = await validateBulkPasswordRows(rows);

  res.json({
    ...result,
    warnings: [
      ...(dupEmails.length ? [`Duplicate emails in batch: ${dupEmails.join(', ')}`] : []),
      ...(dupEmpIds.length ? [`Duplicate employee IDs in batch: ${dupEmpIds.join(', ')}`] : []),
    ],
    limits: { batchMax: BULK_PASSWORD_BATCH_MAX, totalMax: BULK_PASSWORD_TOTAL_MAX },
  });
}));

router.post('/batch', asyncHandler(async (req: Request, res: Response) => {
  const parsed = z.object({
    rows: z.array(rowSchema).min(1).max(BULK_PASSWORD_BATCH_MAX),
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }

  const adminId = (req as unknown as { user?: { empId?: string } }).user?.empId ?? null;
  const rows = parsed.data.rows as BulkPasswordRowInput[];
  const started = Date.now();

  const result = await processBulkPasswordBatch(rows, adminId);

  logger.info(
    {
      rowCount: rows.length,
      updated: result.updated,
      failed: result.failed,
      skipped: result.skipped,
      durationMs: Date.now() - started,
      adminId,
    },
    'Bulk password batch processed',
  );

  await appendAuditLog(adminId ?? 'system', 'BULK_PASSWORD_UPDATE', 'employees', {
    processed: result.processed,
    updated: result.updated,
    failed: result.failed,
    skipped: result.skipped,
  });

  const reportCsv = [
    'line,email,emp_id,action,error,code',
    ...result.rows.map((r) =>
      [
        r.line ?? '',
        r.email,
        r.empId ?? '',
        r.action,
        JSON.stringify(r.error ?? ''),
        r.code ?? '',
      ].join(','),
    ),
  ].join('\n');

  res.json({
    success: result.failed === 0 && result.skipped === 0,
    limits: { batchMax: BULK_PASSWORD_BATCH_MAX, totalMax: BULK_PASSWORD_TOTAL_MAX },
    totalRecords: result.processed,
    updated: result.updated,
    failed: result.failed,
    skipped: result.skipped,
    durationMs: Date.now() - started,
    rows: result.rows.map((r) => ({
      line: r.line,
      email: r.email,
      empId: r.empId,
      action: r.action,
      systems: r.systems,
      error: r.error,
      code: r.code,
    })),
    reportCsv,
  });
}));

export default router;
