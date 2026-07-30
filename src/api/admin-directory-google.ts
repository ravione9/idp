/**
 * Admin — Google Directory attribute mapping, sync settings, full sync, logs.
 * Mounted at /api/admin/directory/google
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { requireRole, requireAnyPortalModule } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import { query, queryOne } from '../db/connection.js';
import { triggerConnectorSync } from '../services/connector-dispatcher.js';
import { runGoogleFullSync, runGoogleSync } from '../services/google-sync.js';
import {
  GOOGLE_SOURCE_ATTR_OPTIONS,
  LOCAL_ATTR_OPTIONS,
  getGoogleSyncSettings,
  listGoogleAttrMaps,
  saveGoogleAttrMaps,
  saveGoogleSyncSettings,
  writeDirectoryUserAudit,
} from '../services/google-attr-map.js';
import { appendAuditLog } from '../utils/audit-log.js';
import logger from '../utils/logger.js';

const router = Router();
router.use(
  requireAuth,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  requireAnyPortalModule('connections', 'identity_users'),
);

function actor(req: Request): string {
  return (req as unknown as { user?: { empId?: string } }).user?.empId ?? 'system';
}

async function findActiveGoogleConnector(): Promise<{ id: string } | null> {
  return queryOne<{ id: string }>(
    `SELECT id FROM connectors
      WHERE connector_type IN ('GOOGLE', 'GOOGLE_WORKSPACE')
        AND status IN ('CONNECTED', 'ACTIVE')
      ORDER BY updated_at DESC LIMIT 1`,
    [],
  );
}

router.get('/attr-maps', asyncHandler(async (_req: Request, res: Response) => {
  const maps = await listGoogleAttrMaps();
  res.json({
    data: maps,
    sourceOptions: GOOGLE_SOURCE_ATTR_OPTIONS,
    localOptions: LOCAL_ATTR_OPTIONS,
  });
}));

const mapsSchema = z.object({
  maps: z.array(z.object({
    source_attr: z.string().min(1).max(120),
    local_attr: z.string().min(1).max(80),
    enabled: z.boolean().optional(),
    sort_order: z.number().int().optional(),
  })).min(1).max(50),
});

router.put('/attr-maps', asyncHandler(async (req: Request, res: Response) => {
  const parsed = mapsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }
  const data = await saveGoogleAttrMaps(parsed.data.maps.map((m) => ({
    source_attr: m.source_attr,
    local_attr: m.local_attr,
    ...(m.enabled !== undefined ? { enabled: m.enabled } : {}),
    ...(m.sort_order !== undefined ? { sort_order: m.sort_order } : {}),
  })));
  await writeDirectoryUserAudit({
    action: 'ATTR_MAP_UPDATE',
    adminEmpId: actor(req),
    source: 'GOOGLE',
    detail: { count: data.length },
  });
  await appendAuditLog(actor(req), 'DIRECTORY_ATTR_MAP_UPDATE', 'GOOGLE', { count: data.length });
  res.json({ data });
}));

router.get('/sync-settings', asyncHandler(async (_req: Request, res: Response) => {
  const settings = await getGoogleSyncSettings();
  res.json({ data: settings });
}));

const settingsSchema = z.object({
  sync_employee_id: z.boolean().optional(),
  sync_department: z.boolean().optional(),
  sync_designation: z.boolean().optional(),
  sync_manager: z.boolean().optional(),
  sync_cost_center: z.boolean().optional(),
  sync_mobile: z.boolean().optional(),
  sync_location: z.boolean().optional(),
  sync_profile_photo: z.boolean().optional(),
  sync_office_address: z.boolean().optional(),
  frequency: z.enum(['15m', '30m', '1h', 'manual']).optional(),
  disable_deleted: z.boolean().optional(),
});

router.put('/sync-settings', asyncHandler(async (req: Request, res: Response) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }
  const d = parsed.data;
  const toFlag = (v: boolean | undefined) => (v === undefined ? undefined : (v ? 1 : 0));
  const settings = await saveGoogleSyncSettings({
    ...(d.sync_employee_id !== undefined ? { sync_employee_id: toFlag(d.sync_employee_id)! } : {}),
    ...(d.sync_department !== undefined ? { sync_department: toFlag(d.sync_department)! } : {}),
    ...(d.sync_designation !== undefined ? { sync_designation: toFlag(d.sync_designation)! } : {}),
    ...(d.sync_manager !== undefined ? { sync_manager: toFlag(d.sync_manager)! } : {}),
    ...(d.sync_cost_center !== undefined ? { sync_cost_center: toFlag(d.sync_cost_center)! } : {}),
    ...(d.sync_mobile !== undefined ? { sync_mobile: toFlag(d.sync_mobile)! } : {}),
    ...(d.sync_location !== undefined ? { sync_location: toFlag(d.sync_location)! } : {}),
    ...(d.sync_profile_photo !== undefined ? { sync_profile_photo: toFlag(d.sync_profile_photo)! } : {}),
    ...(d.sync_office_address !== undefined ? { sync_office_address: toFlag(d.sync_office_address)! } : {}),
    ...(d.frequency !== undefined ? { frequency: d.frequency } : {}),
    ...(d.disable_deleted !== undefined ? { disable_deleted: toFlag(d.disable_deleted)! } : {}),
  }, actor(req));
  await appendAuditLog(actor(req), 'DIRECTORY_SYNC_SETTINGS_UPDATE', 'GOOGLE', { ...d });
  res.json({ data: settings });
}));

router.post('/sync', asyncHandler(async (req: Request, res: Response) => {
  const conn = await findActiveGoogleConnector();
  if (!conn) {
    res.status(404).json({ error: 'No active Google Workspace connector found' });
    return;
  }
  const adminId = actor(req);
  const ref = await triggerConnectorSync(conn.id, adminId);
  await writeDirectoryUserAudit({
    action: 'GOOGLE_SYNC',
    adminEmpId: adminId,
    source: 'GOOGLE',
    detail: { connectorId: conn.id, mode: 'async' },
  });
  res.json({ success: true, connectorId: conn.id, ref });
}));

router.post('/full-sync', asyncHandler(async (req: Request, res: Response) => {
  const conn = await findActiveGoogleConnector();
  if (!conn) {
    res.status(404).json({ error: 'No active Google Workspace connector found' });
    return;
  }
  const adminId = actor(req);
  logger.info({ connectorId: conn.id, adminId }, 'Google full sync requested');
  // Run synchronously so UI can show Added/Updated/Disabled/Duration
  const result = await runGoogleFullSync(conn.id);
  await writeDirectoryUserAudit({
    action: 'GOOGLE_FULL_SYNC',
    adminEmpId: adminId,
    source: 'GOOGLE',
    detail: {
      runId: result.runId,
      usersAdded: result.usersAdded,
      usersUpdated: result.usersUpdated,
      usersDisabled: result.usersDisabled,
      durationMs: result.durationMs,
      failed: result.itemsFailed,
    },
  });
  await appendAuditLog(adminId, 'GOOGLE_FULL_SYNC', conn.id, {
    runId: result.runId,
    usersAdded: result.usersAdded,
    usersUpdated: result.usersUpdated,
    usersDisabled: result.usersDisabled,
  });
  res.json({
    success: result.itemsFailed === 0,
    runId: result.runId,
    connectorId: conn.id,
    usersAdded: result.usersAdded ?? 0,
    usersUpdated: result.usersUpdated ?? 0,
    usersDisabled: result.usersDisabled ?? 0,
    usersFailed: result.itemsFailed,
    durationMs: result.durationMs ?? 0,
    errors: result.errors.slice(0, 25),
  });
}));

router.post('/sync-now', asyncHandler(async (req: Request, res: Response) => {
  const conn = await findActiveGoogleConnector();
  if (!conn) {
    res.status(404).json({ error: 'No active Google Workspace connector found' });
    return;
  }
  const result = await runGoogleSync(conn.id, { runType: 'INCREMENTAL' });
  await writeDirectoryUserAudit({
    action: 'GOOGLE_SYNC_NOW',
    adminEmpId: actor(req),
    source: 'GOOGLE',
    detail: {
      runId: result.runId,
      usersAdded: result.usersAdded,
      usersUpdated: result.usersUpdated,
      durationMs: result.durationMs,
    },
  });
  res.json({
    success: result.itemsFailed === 0,
    runId: result.runId,
    usersAdded: result.usersAdded ?? 0,
    usersUpdated: result.usersUpdated ?? 0,
    usersDisabled: result.usersDisabled ?? 0,
    usersFailed: result.itemsFailed,
    durationMs: result.durationMs ?? 0,
    errors: result.errors.slice(0, 25),
  });
}));

router.get('/logs', asyncHandler(async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(String(req.query['limit'] ?? '50'), 10) || 50, 200);
  const offset = parseInt(String(req.query['offset'] ?? '0'), 10) || 0;

  const auditRows = await query<Record<string, unknown>>(
    `SELECT id, emp_id, action, admin_emp_id, source, changed_fields, old_values, new_values, detail, created_at
       FROM directory_user_audit
      WHERE source = 'GOOGLE' OR action LIKE 'GOOGLE%' OR action LIKE 'ATTR_MAP%' OR action LIKE 'DIRECTORY%'
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?`,
    [limit, offset],
  ).catch(() => [] as Record<string, unknown>[]);

  const conn = await findActiveGoogleConnector();
  let runs: Record<string, unknown>[] = [];
  if (conn) {
    runs = await query<Record<string, unknown>>(
      `SELECT id, run_type, status, started_at, ended_at, items_processed, items_succeeded, items_failed, error_summary
         FROM connector_runs WHERE connector_id = ?
         ORDER BY started_at DESC LIMIT ?`,
      [conn.id, limit],
    );
  }

  res.json({ data: { audit: auditRows, runs }, limit, offset });
}));

export default router;
