/**
 * Config — Groups API
 * Mounted at /api/admin/groups
 * Requires ADMIN or SUPER_ADMIN role.
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../auth/middleware.js';
import { requireRole, requirePortalModule } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import { query, queryOne, execute } from '../db/connection.js';
import { safeQuery } from '../db/safe-query.js';
import { isGroupSyncSchemaReady } from '../services/group-sync.js';
import logger from '../utils/logger.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('ADMIN', 'SUPER_ADMIN'), requirePortalModule('identity_groups'));

const LEGACY_GROUP_LIST_SQL = `
  SELECT g.id, g.name, g.description, g.type, g.active, g.created_at,
         'LOCAL' AS source_system, NULL AS external_id, NULL AS connector_id,
         NULL AS last_synced_at, NULL AS connector_name,
    (SELECT COUNT(*) FROM group_members m
      WHERE m.group_id = (g.id COLLATE utf8mb4_unicode_ci)) AS member_count
   FROM \`groups\` g
  WHERE g.active = 1
  ORDER BY g.name`;

const GROUP_MEMBERS_SQL = `
  SELECT m.emp_id, e.employee_number, e.full_name, e.email_corp
   FROM group_members m
   JOIN employees e ON e.emp_id = (m.emp_id COLLATE utf8mb4_unicode_ci)
  WHERE m.group_id = ?`;

const GROUP_LIST_SQL = `
  SELECT g.id, g.name, g.description, g.type, g.source_system, g.external_id,
         g.connector_id, g.last_synced_at, g.active, g.created_at,
         c.name AS connector_name,
    (SELECT COUNT(*) FROM group_members m
      WHERE m.group_id = (g.id COLLATE utf8mb4_unicode_ci)) AS member_count
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
    for (const key of ['created_at', 'updated_at', 'last_synced_at'] as const) {
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

/** Resolve email, employee_number, or emp_id → employee row. */
async function resolveEmployeeKey(
  raw: string,
): Promise<{ emp_id: string; employee_number: string | null } | null> {
  const key = raw.trim();
  if (!key) return null;
  const byEmpId = await queryOne<{ emp_id: string; employee_number: string | null }>(
    `SELECT emp_id, employee_number FROM employees WHERE emp_id = ? LIMIT 1`,
    [key],
  );
  if (byEmpId) return byEmpId;

  const byNumber = await queryOne<{ emp_id: string; employee_number: string | null }>(
    `SELECT emp_id, employee_number FROM employees WHERE employee_number = ? LIMIT 1`,
    [key],
  );
  if (byNumber) return byNumber;

  if (key.includes('@')) {
    const byEmail = await queryOne<{ emp_id: string; employee_number: string | null }>(
      `SELECT emp_id, employee_number FROM employees WHERE email_corp = ? LIMIT 1`,
      [key.toLowerCase()],
    );
    if (byEmail) return byEmail;
  }
  return null;
}

const MEMBER_CSV_HEADER = /^(email|employee_id|employeeid|employee_number|emp_id|empid|member|identifier)$/i;

/** Split a simple CSV line (supports quoted commas). */
function splitCsvLine(line: string): string[] {
  const parts = line.match(/("([^"]|"")*"|[^,]*)/g);
  if (!parts) return [line.trim()];
  return parts.map((p) => p.trim().replace(/^"|"$/g, '').replace(/""/g, '"'));
}

/**
 * Parse member identifiers from CSV text.
 * Accepts header row (email / employee_id / emp_id) or a single-column list.
 */
function parseMemberCsv(csvText: string): string[] {
  const lines = csvText
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (!lines.length) return [];

  const firstCells = splitCsvLine(lines[0]!);
  const hasHeader = firstCells.some((c) => MEMBER_CSV_HEADER.test(c));
  const out: string[] = [];

  if (hasHeader) {
    const headers = firstCells.map((h) => h.toLowerCase().replace(/["']/g, ''));
    const pickIdx = (...names: string[]) => {
      for (const n of names) {
        const i = headers.indexOf(n);
        if (i >= 0) return i;
      }
      return -1;
    };
    const emailIdx = pickIdx('email', 'email_corp', 'corporate_email');
    const empNoIdx = pickIdx('employee_id', 'employeeid', 'employee_number', 'employee number');
    const empIdIdx = pickIdx('emp_id', 'empid', 'directory_id');
    const memberIdx = pickIdx('member', 'identifier', 'id');

    for (let i = 1; i < lines.length; i++) {
      const cells = splitCsvLine(lines[i]!);
      const candidates = [
        emailIdx >= 0 ? cells[emailIdx] : '',
        empNoIdx >= 0 ? cells[empNoIdx] : '',
        empIdIdx >= 0 ? cells[empIdIdx] : '',
        memberIdx >= 0 ? cells[memberIdx] : '',
      ].map((v) => (v || '').trim()).filter(Boolean);
      if (candidates[0]) out.push(candidates[0]!);
    }
    return out;
  }

  for (const line of lines) {
    const cells = splitCsvLine(line);
    const key = (cells[0] || '').trim();
    if (key) out.push(key);
  }
  return out;
}

type BulkMemberResult = {
  input: string;
  ok: boolean;
  empId?: string;
  employeeNumber?: string | null;
  error?: string;
};

async function bulkMutateMembers(
  groupId: string,
  members: string[],
  action: 'add' | 'remove',
  addedBy: string | null,
): Promise<{
  added: number;
  removed: number;
  skipped: number;
  failed: number;
  results: BulkMemberResult[];
}> {
  const results: BulkMemberResult[] = [];
  let added = 0;
  let removed = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of members) {
    const input = String(entry ?? '').trim();
    if (!input) {
      failed += 1;
      results.push({ input, ok: false, error: 'Empty value' });
      continue;
    }
    try {
      const resolved = await resolveEmployeeKey(input);
      if (!resolved) {
        failed += 1;
        results.push({ input, ok: false, error: 'Employee not found' });
        continue;
      }
      const existing = await queryOne<{ emp_id: string }>(
        `SELECT emp_id FROM group_members WHERE group_id = ? AND emp_id = ? LIMIT 1`,
        [groupId, resolved.emp_id],
      );

      if (action === 'add') {
        if (existing) {
          skipped += 1;
          results.push({
            input,
            ok: true,
            empId: resolved.emp_id,
            employeeNumber: resolved.employee_number,
            error: 'Already a member',
          });
          continue;
        }
        await execute(
          `INSERT IGNORE INTO group_members (group_id, emp_id, added_by) VALUES (?, ?, ?)`,
          [groupId, resolved.emp_id, addedBy],
        );
        added += 1;
        results.push({
          input,
          ok: true,
          empId: resolved.emp_id,
          employeeNumber: resolved.employee_number,
        });
      } else {
        if (!existing) {
          skipped += 1;
          results.push({
            input,
            ok: true,
            empId: resolved.emp_id,
            employeeNumber: resolved.employee_number,
            error: 'Not a member',
          });
          continue;
        }
        await execute(
          `DELETE FROM group_members WHERE group_id = ? AND emp_id = ?`,
          [groupId, resolved.emp_id],
        );
        removed += 1;
        results.push({
          input,
          ok: true,
          empId: resolved.emp_id,
          employeeNumber: resolved.employee_number,
        });
      }
    } catch (err) {
      failed += 1;
      results.push({
        input,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { added, removed, skipped, failed, results };
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

// GET /members/csv-template — downloadable CSV template for bulk add/remove
router.get('/members/csv-template', asyncHandler(async (_req: Request, res: Response) => {
  const csv = 'email,employee_id\nuser@example.com,116970\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="group-members-template.csv"');
  res.send(csv);
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
  let members: Record<string, unknown>[] = [];
  try {
    members = await query<Record<string, unknown>>(GROUP_MEMBERS_SQL, [req.params['id']]);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (
      code === 'ER_CANT_AGGREGATE_2COLLATIONS'
      || code === 'ER_BAD_FIELD_ERROR'
      || code === 'ER_NO_SUCH_TABLE'
    ) {
      logger.warn({ err, groupId: req.params['id'] }, 'Group members query failed — returning empty list');
    } else {
      throw err;
    }
  }
  const normalized = normalizeGroupRows([group])[0]!;
  res.json({ ...normalized, members });
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
// Accepts empId, employeeNumber, or email — resolves to employees.emp_id
router.post('/:id/members', asyncHandler(async (req: Request, res: Response) => {
  const exists = await queryOne<{ id: string }>(
    `SELECT id FROM \`groups\` WHERE id = ?`, [req.params['id']],
  );
  if (!exists) { res.status(404).json({ error: 'Group not found' }); return; }
  if ((await groupSourceSystem(req.params['id']!)) !== 'LOCAL') {
    res.status(409).json({ error: 'Members of synced groups are managed by directory sync (Google / AD)' });
    return;
  }
  const body = req.body as { empId?: string; employeeNumber?: string; email?: string };
  const resolved = await resolveEmployeeKey(
    body.empId || body.employeeNumber || body.email || '',
  );
  if (!resolved) {
    res.status(404).json({ error: 'Employee not found — use email, Employee ID, or directory emp_id' });
    return;
  }
  const addedBy = (req as unknown as { user?: { empId?: string } }).user?.empId ?? null;
  await execute(
    `INSERT IGNORE INTO group_members (group_id, emp_id, added_by) VALUES (?, ?, ?)`,
    [req.params['id'], resolved.emp_id, addedBy],
  );
  res.status(201).json({ success: true, empId: resolved.emp_id, employeeNumber: resolved.employee_number });
}));

// POST /:id/members/bulk — add or remove many members on a local group
// Body: { members?: string[], csvText?: string, action?: 'add'|'remove' }
router.post('/:id/members/bulk', asyncHandler(async (req: Request, res: Response) => {
  const groupId = req.params['id']!;
  const exists = await queryOne<{ id: string }>(
    `SELECT id FROM \`groups\` WHERE id = ?`, [groupId],
  );
  if (!exists) { res.status(404).json({ error: 'Group not found' }); return; }
  if ((await groupSourceSystem(groupId)) !== 'LOCAL') {
    res.status(409).json({ error: 'Members of synced groups are managed by directory sync (Google / AD)' });
    return;
  }

  const body = req.body as { members?: unknown; csvText?: unknown; action?: unknown };
  const action = body.action === 'remove' ? 'remove' : 'add';

  let members: string[] = [];
  if (typeof body.csvText === 'string' && body.csvText.trim()) {
    members = parseMemberCsv(body.csvText);
  } else if (Array.isArray(body.members)) {
    members = body.members.map((m) => String(m ?? '').trim()).filter(Boolean);
  }

  if (!members.length) {
    res.status(400).json({ error: 'members array or csvText required' });
    return;
  }
  if (members.length > 500) {
    res.status(400).json({ error: 'Maximum 500 members per bulk request' });
    return;
  }

  const addedBy = (req as unknown as { user?: { empId?: string } }).user?.empId ?? null;
  const { added, removed, skipped, failed, results } = await bulkMutateMembers(
    groupId, members, action, addedBy,
  );

  logger.info({ groupId, action, added, removed, skipped, failed, by: addedBy }, 'Bulk group members mutate');
  res.json({
    success: failed === 0,
    action,
    added,
    removed,
    skipped,
    failed,
    processed: results.length,
    results,
  });
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
  // Allow remove by emp_id or employee_number
  const key = String(req.params['empId'] || '');
  const resolved = await resolveEmployeeKey(key);
  const empId = resolved?.emp_id || key;
  await execute(
    `DELETE FROM group_members WHERE group_id = ? AND emp_id = ?`,
    [req.params['id'], empId],
  );
  res.json({ success: true });
}));

export default router;
