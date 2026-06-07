/**
 * Bulk user import — upsert employees and add to local groups in batches.
 * Designed for admin CSV uploads (up to 100k rows via chunked API calls).
 */
import { v4 as uuidv4 } from 'uuid';
import type { PoolConnection } from 'mysql2/promise';
import { query, execute, transaction } from '../db/connection.js';
import logger from '../utils/logger.js';

const EMP_TYPES = new Set(['CORPORATE', 'STORE', 'PLANT', 'DC']);
const ILG_STATES = new Set([
  'ACTIVE', 'SUSPENDED_AUTO', 'PENDING_MGR', 'ESCALATED_HRBP',
  'REACTIVATED', 'SUSPENDED_HR', 'DEPARTED', 'DEPROVISIONED',
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BulkImportMode = 'upsert' | 'create' | 'update';

export interface BulkUserRowInput {
  line?: number | undefined;
  email: string;
  fullName: string;
  empId?: string | undefined;
  deptId?: string | undefined;
  employmentType?: string | undefined;
  ilgState?: string | undefined;
  managerEmpId?: string | undefined;
  groups?: string[] | undefined;
}

export interface BulkRowResult {
  line?: number | undefined;
  email: string;
  empId?: string | undefined;
  action: 'created' | 'updated' | 'skipped' | 'failed';
  groupsAdded?: number | undefined;
  groupWarnings?: string[] | undefined;
  error?: string | undefined;
}

export interface BulkImportResult {
  processed: number;
  created: number;
  updated: number;
  failed: number;
  groupsAdded: number;
  rows: BulkRowResult[];
}

interface GroupRef {
  id: string;
  name: string;
  sourceSystem: string;
}

function nextBulkEmpId(): string {
  return `BLK${uuidv4().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function loadExistingByEmails(
  emails: string[],
  conn: PoolConnection,
): Promise<Map<string, { emp_id: string }>> {
  const map = new Map<string, { emp_id: string }>();
  if (emails.length === 0) return map;

  const chunkSize = 500;
  for (let i = 0; i < emails.length; i += chunkSize) {
    const chunk = emails.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await query<{ emp_id: string; email_corp: string }>(
      `SELECT emp_id, email_corp FROM employees WHERE email_corp IN (${placeholders})`,
      chunk,
      conn,
    );
    for (const row of rows) {
      map.set(normalizeEmail(row.email_corp), { emp_id: row.emp_id });
    }
  }
  return map;
}

async function loadGroupIndex(conn: PoolConnection): Promise<{
  byId: Map<string, GroupRef>;
  byName: Map<string, GroupRef>;
}> {
  const byId = new Map<string, GroupRef>();
  const byName = new Map<string, GroupRef>();

  let rows: Array<{ id: string; name: string; source_system?: string }>;
  try {
    rows = await query(
      `SELECT id, name, source_system FROM \`groups\` WHERE active = 1`,
      [],
      conn,
    );
  } catch {
    rows = await query(
      `SELECT id, name FROM \`groups\` WHERE active = 1`,
      [],
      conn,
    );
  }

  for (const row of rows) {
    const ref: GroupRef = {
      id: row.id,
      name: row.name,
      sourceSystem: row.source_system ?? 'LOCAL',
    };
    byId.set(row.id.toLowerCase(), ref);
    byName.set(row.name.trim().toLowerCase(), ref);
  }
  return { byId, byName };
}

function resolveGroups(
  tokens: string[] | undefined,
  groupIndex: { byId: Map<string, GroupRef>; byName: Map<string, GroupRef> },
): { localGroupIds: string[]; warnings: string[] } {
  const localGroupIds: string[] = [];
  const warnings: string[] = [];
  if (!tokens?.length) return { localGroupIds, warnings };

  const seen = new Set<string>();
  for (const raw of tokens) {
    const token = raw.trim();
    if (!token) continue;

    const ref = UUID_RE.test(token)
      ? groupIndex.byId.get(token.toLowerCase())
      : groupIndex.byName.get(token.toLowerCase());

    if (!ref) {
      warnings.push(`Group not found: ${token}`);
      continue;
    }
    if (ref.sourceSystem !== 'LOCAL') {
      warnings.push(`Group "${ref.name}" is synced (${ref.sourceSystem}) — skipped`);
      continue;
    }
    if (!seen.has(ref.id)) {
      seen.add(ref.id);
      localGroupIds.push(ref.id);
    }
  }
  return { localGroupIds, warnings };
}

export async function processBulkUserBatch(
  rows: BulkUserRowInput[],
  mode: BulkImportMode,
  addedBy: string | null,
): Promise<BulkImportResult> {
  const result: BulkImportResult = {
    processed: 0,
    created: 0,
    updated: 0,
    failed: 0,
    groupsAdded: 0,
    rows: [],
  };

  if (rows.length === 0) return result;

  await transaction(async (conn) => {
    const emails = rows.map((r) => normalizeEmail(r.email));
    const existingMap = await loadExistingByEmails(emails, conn);
    const groupIndex = await loadGroupIndex(conn);
    const seenInBatch = new Set<string>();

    const memberships: Array<{ groupId: string; empId: string }> = [];

    for (const row of rows) {
      result.processed++;
      const line = row.line;
      const email = normalizeEmail(row.email);
      const fullName = row.fullName?.trim() ?? '';
      const rowResult: BulkRowResult = { email, action: 'failed' };
      if (line !== undefined) rowResult.line = line;

      try {
        if (!email || !email.includes('@')) {
          throw new Error('Invalid email');
        }
        if (!fullName || fullName.length < 2) {
          throw new Error('fullName must be at least 2 characters');
        }
        if (seenInBatch.has(email)) {
          throw new Error('Duplicate email in batch');
        }
        seenInBatch.add(email);

        const empType = row.employmentType?.trim().toUpperCase() ?? 'CORPORATE';
        if (!EMP_TYPES.has(empType)) {
          throw new Error(`Invalid employmentType: ${row.employmentType}`);
        }

        const ilgState = row.ilgState?.trim().toUpperCase() ?? 'ACTIVE';
        if (!ILG_STATES.has(ilgState)) {
          throw new Error(`Invalid ilgState: ${row.ilgState}`);
        }

        const existing = existingMap.get(email);
        let empId = row.empId?.trim() || existing?.emp_id;

        if (mode === 'create' && existing) {
          throw new Error('User already exists (create-only mode)');
        }
        if (mode === 'update' && !existing) {
          throw new Error('User not found (update-only mode)');
        }

        if (!empId) {
          empId = nextBulkEmpId();
        }

        if (existing) {
          await execute(
            `UPDATE employees SET
               full_name = ?,
               dept_id = COALESCE(?, dept_id),
               employment_type = ?,
               ilg_state = ?,
               manager_emp_id = COALESCE(?, manager_emp_id),
               updated_at = UTC_TIMESTAMP()
             WHERE emp_id = ?`,
            [
              fullName,
              row.deptId?.trim() || null,
              empType,
              ilgState,
              row.managerEmpId?.trim() || null,
              existing.emp_id,
            ],
            conn,
          );
          empId = existing.emp_id;
          rowResult.action = 'updated';
          result.updated++;
        } else {
          await execute(
            `INSERT INTO employees
               (emp_id, full_name, email_corp, dept_id, employment_type, ilg_state,
                manager_emp_id, hire_date, hrms_status)
             VALUES (?, ?, ?, ?, ?, ?, ?, UTC_DATE(), 'ACTIVE')`,
            [
              empId,
              fullName,
              email,
              row.deptId?.trim() || null,
              empType,
              ilgState,
              row.managerEmpId?.trim() || null,
            ],
            conn,
          );
          existingMap.set(email, { emp_id: empId });
          rowResult.action = 'created';
          result.created++;
        }

        rowResult.empId = empId;

        const { localGroupIds, warnings } = resolveGroups(row.groups, groupIndex);
        if (warnings.length) rowResult.groupWarnings = warnings;

        let groupsAddedForRow = 0;
        for (const groupId of localGroupIds) {
          memberships.push({ groupId, empId });
          groupsAddedForRow++;
        }
        if (groupsAddedForRow > 0) rowResult.groupsAdded = groupsAddedForRow;

        result.rows.push(rowResult);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        rowResult.error = msg;
        rowResult.action = 'failed';
        result.failed++;
        result.rows.push(rowResult);
        logger.debug({ email, line, err: msg }, 'Bulk user row failed');
      }
    }

    if (memberships.length > 0) {
      const chunkSize = 200;
      for (let i = 0; i < memberships.length; i += chunkSize) {
        const chunk = memberships.slice(i, i + chunkSize);
        const values = chunk.map(() => '(?, ?, ?)').join(', ');
        const params: unknown[] = [];
        for (const m of chunk) {
          params.push(m.groupId, m.empId, addedBy);
        }
        const header = await execute(
          `INSERT IGNORE INTO group_members (group_id, emp_id, added_by) VALUES ${values}`,
          params,
          conn,
        );
        result.groupsAdded += header.affectedRows ?? 0;
      }
    }
  });

  return result;
}
