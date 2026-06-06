/**
 * Config — Groups API
 * Mounted at /api/admin/groups
 * Requires ADMIN or SUPER_ADMIN role.
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../auth/middleware.js';
import { requireRole } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import { query, queryOne, execute } from '../db/connection.js';
import { safeQuery } from '../db/safe-query.js';
import { isGroupSyncSchemaReady } from '../services/group-sync.js';
import logger from '../utils/logger.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('ADMIN', 'SUPER_ADMIN'));

const LEGACY_GROUP_LIST_SQL = `
  SELECT g.id, g.name, g.description, g.type, g.active, g.created_at,
         'LOCAL' AS source_system, NULL AS external_id, NULL AS connector_id,
         NULL AS last_synced_at, NULL AS connector_name,
    (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS member_count
   FROM \`groups\` g
  WHERE g.active = 1
  ORDER BY g.name`;

const GROUP_LIST_SQL = `
  SELECT g.id, g.name, g.description, g.type, g.source_system, g.external_id,
         g.connector_id, g.last_synced_at, g.active, g.created_at,
         c.name AS connector_name,
    (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS member_count
   FROM \`groups\` g
   LEFT JOIN connectors c ON c.id = (g.connector_id COLLATE utf8mb4_unicode_ci)
  WHERE g.active = 1
  ORDER BY g.source_system, g.name`;

function normalizeGroupRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    if (typeof out['member_count'] === 'bigint') {
      out['member_count'] = Number(out['member_count']);
    }
    for (const key of ['created_at', 'last_synced_at'] as const) {
      const v = out[key];
      if (v instanceof Date) out[key] = v.toISOString();
    }
    return out;
  });
}

async function listGroups(): Promise<Record<string, unknown>[]> {
  if (await isGroupSyncSchemaReady()) {
    try {
      const rows = await query<Record<string, unknown>>(GROUP_LIST_SQL, []);
      return normalizeGroupRows(rows);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (
        code !== 'ER_BAD_FIELD_ERROR'
        && code !== 'ER_NO_SUCH_TABLE'
        && code !== 'ER_CANT_AGGREGATE_2COLLATIONS'
      ) throw err;
      logger.warn({ err }, 'Groups list: extended query failed — falling back to legacy');
    }
  }
  const rows = await safeQuery<Record<string, unknown>>(LEGACY_GROUP_LIST_SQL, []);
  return normalizeGroupRows(rows);
}

async function groupSourceSystem(groupId: string): Promise<string> {
  const schemaReady = await isGroupSyncSchemaReady();
  if (!schemaReady) return 'LOCAL';
  const row = await queryOne<{ source_system: string }>(
    `SELECT source_system FROM \`groups\` WHERE id = ?`,
    [groupId],
  );
  return row?.source_system ?? 'LOCAL';
}

// POST /sync — pull groups + members from Google / AD connectors (syncGroups config)
router.post('/sync', asyncHandler(async (_req: Request, res: Response) => {
  if (!(await isGroupSyncSchemaReady())) {
    res.status(503).json({
      error: 'Group directory sync requires migration 014 — restart the API after deploy so migrations apply',
    });
    return;
  }
  const { syncAllDirectoryGroups } = await import('../services/group-sync.js');
  const result = await syncAllDirectoryGroups();
  res.json({
    success: true,
    groupsSynced: result.groupsSynced,
    membersSynced: result.membersSynced,
    errors: result.errors,
  });
}));

// GET / — list groups with member count
router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await listGroups();
  res.json({ data: rows, schemaReady: await isGroupSyncSchemaReady() });
}));

// POST / — create group
router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const { name, description, type = 'STATIC', rule_json } = req.body as {
    name: string; description?: string; type?: string; rule_json?: unknown;
  };
  if (!name) { res.status(400).json({ error: 'name required' }); return; }
  const id = uuidv4();
  const empId = (req as unknown as { user?: { empId?: string } }).user?.empId ?? null;
  await execute(
    `INSERT INTO \`groups\` (id, name, description, type, rule_json, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, name, description ?? null, type, rule_json ? JSON.stringify(rule_json) : null, empId],
  );
  res.status(201).json({ id });
}));

// GET /:id — get group with members
router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
  const group = await queryOne<Record<string, unknown>>(
    `SELECT * FROM \`groups\` WHERE id = ?`, [req.params['id']],
  );
  if (!group) { res.status(404).json({ error: 'Not found' }); return; }
  const members = await query(
    `SELECT m.emp_id, e.full_name, e.email_corp
     FROM group_members m
     JOIN employees e ON e.emp_id = m.emp_id
     WHERE m.group_id = ?`,
    [req.params['id']],
  );
  res.json({ ...group, members });
}));

// PUT /:id — update group
router.put('/:id', asyncHandler(async (req: Request, res: Response) => {
  const { name, description, active } = req.body as {
    name?: string; description?: string; active?: number;
  };
  await execute(
    `UPDATE \`groups\` SET
       name = COALESCE(?, name),
       description = COALESCE(?, description),
       active = COALESCE(?, active),
       updated_at = UTC_TIMESTAMP()
     WHERE id = ?`,
    [name ?? null, description ?? null, active ?? null, req.params['id']],
  );
  res.json({ success: true });
}));

// DELETE /:id — soft delete
router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  await execute(
    `UPDATE \`groups\` SET active = 0, updated_at = UTC_TIMESTAMP() WHERE id = ?`,
    [req.params['id']],
  );
  res.json({ success: true });
}));

// POST /:id/members — add member (local groups only)
router.post('/:id/members', asyncHandler(async (req: Request, res: Response) => {
  const exists = await queryOne<{ id: string }>(
    `SELECT id FROM \`groups\` WHERE id = ?`, [req.params['id']],
  );
  if (!exists) { res.status(404).json({ error: 'Group not found' }); return; }
  if ((await groupSourceSystem(req.params['id']!)) !== 'LOCAL') {
    res.status(409).json({ error: 'Members of synced groups are managed by directory sync (Google / AD)' });
    return;
  }
  const { empId } = req.body as { empId: string };
  if (!empId) { res.status(400).json({ error: 'empId required' }); return; }
  const addedBy = (req as unknown as { user?: { empId?: string } }).user?.empId ?? null;
  await execute(
    `INSERT IGNORE INTO group_members (group_id, emp_id, added_by) VALUES (?, ?, ?)`,
    [req.params['id'], empId, addedBy],
  );
  res.status(201).json({ success: true });
}));

// DELETE /:id/members/:empId — remove member (local groups only)
router.delete('/:id/members/:empId', asyncHandler(async (req: Request, res: Response) => {
  const exists = await queryOne<{ id: string }>(
    `SELECT id FROM \`groups\` WHERE id = ?`, [req.params['id']],
  );
  if (!exists) { res.status(404).json({ error: 'Group not found' }); return; }
  if ((await groupSourceSystem(req.params['id']!)) !== 'LOCAL') {
    res.status(409).json({ error: 'Members of synced groups are managed by directory sync (Google / AD)' });
    return;
  }
  await execute(
    `DELETE FROM group_members WHERE group_id = ? AND emp_id = ?`,
    [req.params['id'], req.params['empId']],
  );
  res.json({ success: true });
}));

export default router;
