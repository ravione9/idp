/**
 * Bulk user import — upsert employees and add to local groups in batches.
 * Supports mandatory HR fields + optional manager/mobile/location/groups/roles.
 */
import { v4 as uuidv4 } from 'uuid';
import type { PoolConnection } from 'mysql2/promise';
import { query, execute, transaction, queryOne } from '../db/connection.js';
import logger from '../utils/logger.js';
import { writeDirectoryUserAudit } from './google-attr-map.js';
import { reconcileDynamicGroupsForEmployee } from './dynamic-groups.js';

const EMP_TYPES = new Set(['CORPORATE', 'STORE', 'PLANT', 'DC']);
const ILG_STATES = new Set([
  'ACTIVE', 'SUSPENDED_AUTO', 'PENDING_MGR', 'ESCALATED_HRBP',
  'REACTIVATED', 'SUSPENDED_HR', 'DEPARTED', 'DEPROVISIONED',
  'INACTIVE', 'DISABLED',
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type BulkImportMode = 'upsert' | 'create' | 'update';

export interface BulkUserRowInput {
  line?: number | undefined;
  employeeId?: string | undefined;
  empId?: string | undefined;
  firstName?: string | undefined;
  lastName?: string | undefined;
  fullName?: string | undefined;
  email: string;
  department?: string | undefined;
  deptId?: string | undefined;
  designation?: string | undefined;
  username?: string | undefined;
  status?: string | undefined;
  ilgState?: string | undefined;
  manager?: string | undefined;
  managerEmpId?: string | undefined;
  mobile?: string | undefined;
  location?: string | undefined;
  costCenter?: string | undefined;
  employeeType?: string | undefined;
  employmentType?: string | undefined;
  joiningDate?: string | undefined;
  businessRole?: string | undefined;
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
  code?: string | undefined;
}

export interface BulkImportResult {
  processed: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  groupsAdded: number;
  rows: BulkRowResult[];
}

export interface BulkValidationIssue {
  line?: number;
  email?: string;
  employeeId?: string;
  field?: string;
  code: string;
  message: string;
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

function composeFullName(row: BulkUserRowInput): string {
  if (row.fullName?.trim()) return row.fullName.trim();
  return [row.firstName, row.lastName].filter((s) => s?.trim()).join(' ').trim();
}

function mapStatus(raw?: string): string {
  const s = (raw || 'ACTIVE').trim().toUpperCase();
  if (s === 'INACTIVE' || s === 'DISABLED' || s === 'OFF') return 'SUSPENDED_HR';
  if (s === 'ENABLED' || s === 'ENABLE') return 'ACTIVE';
  return s;
}

async function loadExistingByEmails(
  emails: string[],
  conn: PoolConnection,
): Promise<Map<string, { emp_id: string; employee_number: string | null }>> {
  const map = new Map<string, { emp_id: string; employee_number: string | null }>();
  if (emails.length === 0) return map;

  const chunkSize = 500;
  for (let i = 0; i < emails.length; i += chunkSize) {
    const chunk = emails.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await query<{ emp_id: string; email_corp: string; employee_number: string | null }>(
      `SELECT emp_id, email_corp, employee_number FROM employees WHERE email_corp IN (${placeholders})`,
      chunk,
      conn,
    );
    for (const row of rows) {
      map.set(normalizeEmail(row.email_corp), { emp_id: row.emp_id, employee_number: row.employee_number });
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

/** Dry-run validation for UI preview. */
export async function validateBulkUserRows(rows: BulkUserRowInput[]): Promise<{
  valid: number;
  invalid: number;
  issues: BulkValidationIssue[];
  preview: Array<Record<string, unknown>>;
}> {
  const issues: BulkValidationIssue[] = [];
  const preview: Array<Record<string, unknown>> = [];
  const seenEmails = new Set<string>();
  const seenEmpIds = new Set<string>();

  const emails = rows.map((r) => normalizeEmail(r.email || '')).filter(Boolean);
  const existing = new Map<string, { emp_id: string; employee_number: string | null }>();
  if (emails.length) {
    const chunkSize = 500;
    for (let i = 0; i < emails.length; i += chunkSize) {
      const chunk = emails.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(', ');
      const found = await query<{ emp_id: string; email_corp: string; employee_number: string | null }>(
        `SELECT emp_id, email_corp, employee_number FROM employees WHERE email_corp IN (${placeholders})`,
        chunk,
      );
      for (const row of found) {
        existing.set(normalizeEmail(row.email_corp), { emp_id: row.emp_id, employee_number: row.employee_number });
      }
    }
  }

  for (const row of rows) {
    const line = row.line;
    const email = normalizeEmail(row.email || '');
    const empNumber = (row.employeeId || row.empId || '').trim();
    const firstName = (row.firstName || '').trim();
    const lastName = (row.lastName || '').trim();
    const fullName = composeFullName(row);
    const department = (row.department || row.deptId || '').trim();
    const designation = (row.designation || '').trim();
    const username = (row.username || '').trim();
    const status = mapStatus(row.status || row.ilgState);

    const rowIssues: BulkValidationIssue[] = [];
    const push = (code: string, message: string, field?: string) => {
      const issue: BulkValidationIssue = { code, message };
      if (line !== undefined) issue.line = line;
      if (email) issue.email = email;
      if (empNumber) issue.employeeId = empNumber;
      if (field) issue.field = field;
      rowIssues.push(issue);
    };

    if (!empNumber) push('MISSING_REQUIRED', 'Employee ID is required', 'employeeId');
    if (!firstName && !fullName) push('MISSING_REQUIRED', 'First Name is required', 'firstName');
    if (!lastName && !fullName) push('MISSING_REQUIRED', 'Last Name is required', 'lastName');
    if (!email) push('MISSING_REQUIRED', 'Email is required', 'email');
    else if (!EMAIL_RE.test(email)) push('INVALID_EMAIL', 'Invalid email format', 'email');
    if (!department) push('MISSING_REQUIRED', 'Department is required', 'department');
    if (!designation) push('MISSING_REQUIRED', 'Designation is required', 'designation');
    if (!username) push('MISSING_REQUIRED', 'Username is required', 'username');
    if (!status) push('MISSING_REQUIRED', 'Status is required', 'status');
    else if (!ILG_STATES.has(status) && status !== 'SUSPENDED_HR') {
      push('INVALID_STATUS', `Invalid status: ${row.status}`, 'status');
    }

    if (email && seenEmails.has(email)) push('DUPLICATE_EMAIL', 'Duplicate email in file', 'email');
    if (empNumber && seenEmpIds.has(empNumber.toLowerCase())) {
      push('DUPLICATE_EMPLOYEE_ID', 'Duplicate Employee ID in file', 'employeeId');
    }
    if (email) seenEmails.add(email);
    if (empNumber) seenEmpIds.add(empNumber.toLowerCase());

    if (email && existing.has(email)) {
      push('EXISTING_USER', 'User already exists (will update on upsert)', 'email');
    }

    const managerRef = (row.manager || row.managerEmpId || '').trim();
    if (managerRef) {
      const mgr = await queryOne<{ emp_id: string }>(
        `SELECT emp_id FROM employees WHERE emp_id = ? OR email_corp = ? LIMIT 1`,
        [managerRef, managerRef.toLowerCase()],
      );
      if (!mgr) push('INVALID_MANAGER', 'Manager not found', 'manager');
    }

    issues.push(...rowIssues.filter((i) => i.code !== 'EXISTING_USER'));
    // EXISTING_USER is informational for upsert — count as warning but not invalid for preview
    const hardErrors = rowIssues.filter((i) => i.code !== 'EXISTING_USER');
    preview.push({
      line,
      employeeId: empNumber,
      firstName: firstName || fullName.split(/\s+/)[0] || '',
      lastName: lastName || fullName.split(/\s+/).slice(1).join(' ') || '',
      email,
      department,
      designation,
      username,
      status,
      manager: managerRef || null,
      mobile: row.mobile || null,
      location: row.location || null,
      costCenter: row.costCenter || null,
      employeeType: row.employeeType || row.employmentType || 'CORPORATE',
      joiningDate: row.joiningDate || null,
      businessRole: row.businessRole || null,
      groups: row.groups || [],
      valid: hardErrors.length === 0,
      existing: existing.has(email),
      errors: hardErrors.map((i) => i.message),
    });
  }

  const invalid = preview.filter((p) => !p.valid).length;
  return { valid: preview.length - invalid, invalid, issues, preview };
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
    skipped: 0,
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
    const seenEmpIds = new Set<string>();
    const memberships: Array<{ groupId: string; empId: string }> = [];

    for (const row of rows) {
      result.processed++;
      const line = row.line;
      const email = normalizeEmail(row.email);
      const empNumber = (row.employeeId || row.empId || '').trim();
      const firstName = (row.firstName || '').trim();
      const lastName = (row.lastName || '').trim();
      const fullName = composeFullName(row);
      const department = (row.department || row.deptId || '').trim();
      const designation = (row.designation || '').trim();
      const username = (row.username || '').trim();
      const rowResult: BulkRowResult = { email, action: 'failed' };
      if (line !== undefined) rowResult.line = line;

      try {
        if (!email || !EMAIL_RE.test(email)) throw Object.assign(new Error('Invalid email format'), { code: 'INVALID_EMAIL' });
        if (!fullName || fullName.length < 2) throw Object.assign(new Error('First/Last name required'), { code: 'MISSING_REQUIRED' });
        if (!empNumber) throw Object.assign(new Error('Employee ID is required'), { code: 'MISSING_REQUIRED' });
        if (!department) throw Object.assign(new Error('Department is required'), { code: 'MISSING_REQUIRED' });
        if (!designation) throw Object.assign(new Error('Designation is required'), { code: 'MISSING_REQUIRED' });
        if (!username) throw Object.assign(new Error('Username is required'), { code: 'MISSING_REQUIRED' });
        if (seenInBatch.has(email)) throw Object.assign(new Error('Duplicate email in batch'), { code: 'DUPLICATE_EMAIL' });
        if (seenEmpIds.has(empNumber.toLowerCase())) {
          throw Object.assign(new Error('Duplicate Employee ID in batch'), { code: 'DUPLICATE_EMPLOYEE_ID' });
        }
        seenInBatch.add(email);
        seenEmpIds.add(empNumber.toLowerCase());

        const empType = (row.employeeType || row.employmentType || 'CORPORATE').trim().toUpperCase();
        if (!EMP_TYPES.has(empType)) {
          throw Object.assign(new Error(`Invalid employee type: ${empType}`), { code: 'INVALID_EMPLOYEE_TYPE' });
        }

        const ilgState = mapStatus(row.status || row.ilgState);
        if (!ILG_STATES.has(ilgState)) {
          throw Object.assign(new Error(`Invalid status: ${row.status}`), { code: 'INVALID_STATUS' });
        }

        let managerEmpId = (row.managerEmpId || '').trim() || null;
        const managerRef = (row.manager || '').trim();
        if (managerRef) {
          const mgr = await queryOne<{ emp_id: string }>(
            `SELECT emp_id FROM employees WHERE emp_id = ? OR email_corp = ? LIMIT 1`,
            [managerRef, managerRef.toLowerCase()],
            conn,
          );
          if (!mgr) throw Object.assign(new Error('Manager not found'), { code: 'INVALID_MANAGER' });
          managerEmpId = mgr.emp_id;
        }

        const existing = existingMap.get(email);
        let empId = empNumber.length <= 20 ? empNumber : (existing?.emp_id || nextBulkEmpId());

        // Conflict: employee_number used by another email
        const byNumber = await queryOne<{ emp_id: string; email_corp: string }>(
          `SELECT emp_id, email_corp FROM employees WHERE employee_number = ? OR emp_id = ? LIMIT 1`,
          [empNumber, empNumber],
          conn,
        );
        if (byNumber && normalizeEmail(byNumber.email_corp) !== email) {
          throw Object.assign(new Error('Employee ID already exists'), { code: 'DUPLICATE_EMPLOYEE_ID' });
        }

        if (mode === 'create' && existing) {
          throw Object.assign(new Error('User already exists'), { code: 'EXISTING_USER' });
        }
        if (mode === 'update' && !existing) {
          throw Object.assign(new Error('User not found'), { code: 'USER_NOT_FOUND' });
        }

        if (existing) {
          empId = existing.emp_id;
          await execute(
            `UPDATE employees SET
               full_name = ?, first_name = ?, last_name = ?, username = ?, employee_number = ?,
               dept_id = ?, role = ?, employment_type = ?, ilg_state = ?,
               manager_emp_id = COALESCE(?, manager_emp_id),
               mobile = COALESCE(?, mobile),
               location = COALESCE(?, location),
               cost_center = COALESCE(?, cost_center),
               hire_date = COALESCE(?, hire_date),
               updated_at = UTC_TIMESTAMP()
             WHERE emp_id = ?`,
            [
              fullName,
              firstName || fullName.split(/\s+/)[0] || null,
              lastName || fullName.split(/\s+/).slice(1).join(' ') || null,
              username,
              empNumber,
              department,
              designation,
              empType,
              ilgState,
              managerEmpId,
              row.mobile?.trim() || null,
              row.location?.trim() || null,
              row.costCenter?.trim() || null,
              row.joiningDate?.trim() || null,
              empId,
            ],
            conn,
          );
          rowResult.action = 'updated';
          result.updated++;
        } else {
          if (!empId || empId.length > 20) empId = nextBulkEmpId();
          await execute(
            `INSERT INTO employees
               (emp_id, employee_number, full_name, first_name, last_name, username, email_corp,
                dept_id, role, employment_type, ilg_state, manager_emp_id, mobile, location,
                cost_center, hire_date, hrms_status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, UTC_DATE()), 'ACTIVE')`,
            [
              empId,
              empNumber,
              fullName,
              firstName || fullName.split(/\s+/)[0] || null,
              lastName || fullName.split(/\s+/).slice(1).join(' ') || null,
              username,
              email,
              department,
              designation,
              empType,
              ilgState,
              managerEmpId,
              row.mobile?.trim() || null,
              row.location?.trim() || null,
              row.costCenter?.trim() || null,
              row.joiningDate?.trim() || null,
            ],
            conn,
          );
          existingMap.set(email, { emp_id: empId, employee_number: empNumber });
          rowResult.action = 'created';
          result.created++;
        }

        rowResult.empId = empId;

        if (row.businessRole?.trim()) {
          try {
            const br = await queryOne<{ id: string }>(
              `SELECT id FROM business_roles WHERE name = ? OR id = ? LIMIT 1`,
              [row.businessRole.trim(), row.businessRole.trim()],
              conn,
            );
            if (br) {
              await execute(
                `INSERT IGNORE INTO employee_business_roles (emp_id, business_role_id) VALUES (?, ?)`,
                [empId, br.id],
                conn,
              ).catch(() => undefined);
            }
          } catch {
            // business role tables may not exist — ignore
          }
        }

        const { localGroupIds, warnings } = resolveGroups(row.groups, groupIndex);
        if (warnings.length) rowResult.groupWarnings = warnings;

        let groupsAddedForRow = 0;
        for (const groupId of localGroupIds) {
          memberships.push({ groupId, empId });
          groupsAddedForRow++;
        }
        if (groupsAddedForRow > 0) rowResult.groupsAdded = groupsAddedForRow;

        await reconcileDynamicGroupsForEmployee(empId, addedBy).catch((err) =>
          logger.debug({ err, empId, email }, 'Dynamic group reconcile after bulk user row failed'),
        );

        result.rows.push(rowResult);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = (err as { code?: string })?.code;
        rowResult.error = msg;
        if (code) rowResult.code = code;
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

  await writeDirectoryUserAudit({
    action: 'BULK_IMPORT',
    adminEmpId: addedBy,
    source: 'LOCAL',
    detail: {
      mode,
      processed: result.processed,
      created: result.created,
      updated: result.updated,
      failed: result.failed,
    },
  });

  return result;
}

export const BULK_TEMPLATE_HEADERS = [
  'employee_id',
  'first_name',
  'last_name',
  'email',
  'department',
  'designation',
  'username',
  'status',
  'manager',
  'mobile',
  'location',
  'cost_center',
  'employee_type',
  'joining_date',
  'business_role',
  'groups',
] as const;

export function bulkTemplateCsv(): string {
  const sample = [
    'E12345',
    'Jane',
    'Doe',
    'jane.doe@example.com',
    'Engineering',
    'Software Engineer',
    'jane.doe',
    'ACTIVE',
    'manager@example.com',
    '+911234567890',
    'Bangalore',
    'CC-100',
    'CORPORATE',
    '2024-01-15',
    '',
    'Team A|Team B',
  ];
  return `${BULK_TEMPLATE_HEADERS.join(',')}\n${sample.join(',')}\n`;
}
