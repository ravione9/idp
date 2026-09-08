/**
 * Dynamic group membership — department and email-domain rules on local DYNAMIC groups.
 *
 * Rule shape (stored in groups.rule_json):
 *   { "dept_ids": ["Engineering", "IT"], "email_domains": ["fos.lenskart.in"] }
 * or legacy:
 *   { "field": "dept_id", "op": "eq"|"in", "value": "Engineering" }
 *   { "field": "dept_id", "op": "in", "value": ["Engineering", "IT"] }
 */
import { query, queryOne, execute } from '../db/connection.js';
import { isGroupSyncSchemaReady } from './group-sync.js';
import logger from '../utils/logger.js';

const MEMBER_BATCH = 300;

export interface DynamicGroupRule {
  dept_ids?: string[];
  email_domains?: string[];
}

interface DynamicGroupRow {
  id: string;
  name: string;
  type: string;
  rule_json: unknown;
  source_system: string | null;
  active: number;
}

interface EmployeeRow {
  emp_id: string;
  dept_id: string | null;
  email_corp: string | null;
  ilg_state: string;
}

function normList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean);
}

function normDomains(v: unknown): string[] {
  return normList(v).map((d) => d.replace(/^@+/, '').toLowerCase()).filter(Boolean);
}

export function emailDomainOf(email: string | null | undefined): string | null {
  const raw = (email || '').trim().toLowerCase();
  const at = raw.lastIndexOf('@');
  if (at < 1 || at >= raw.length - 1) return null;
  return raw.slice(at + 1);
}

export function parseDynamicRule(raw: unknown): DynamicGroupRule {
  if (raw == null || raw === '') return {};
  let obj: Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  } else if (typeof raw === 'object') {
    obj = raw as Record<string, unknown>;
  } else {
    return {};
  }

  const rule: DynamicGroupRule = {};
  const deptIds = normList(obj.dept_ids);
  const domains = normDomains(obj.email_domains);
  if (deptIds.length) rule.dept_ids = deptIds;
  if (domains.length) rule.email_domains = domains;

  if (rule.dept_ids?.length || rule.email_domains?.length) return rule;

  const field = String(obj.field ?? '').toLowerCase();
  if (field === 'dept_id' || field === 'department') {
    const value = obj.value;
    if (Array.isArray(value)) {
      const fromArray = normList(value);
      if (fromArray.length) return { dept_ids: fromArray };
    } else if (value != null && String(value).trim()) {
      return { dept_ids: [String(value).trim()] };
    }
  }

  return {};
}

export function buildDynamicRule(input: {
  dept_ids?: string[];
  email_domains?: string[];
}): DynamicGroupRule {
  const rule: DynamicGroupRule = {};
  const depts = normList(input.dept_ids);
  const domains = normDomains(input.email_domains);
  if (depts.length) rule.dept_ids = depts;
  if (domains.length) rule.email_domains = domains;
  return rule;
}

export function validateDynamicRule(rule: DynamicGroupRule): string | null {
  const depts = normList(rule.dept_ids);
  const domains = normDomains(rule.email_domains);
  if (!depts.length && !domains.length) {
    return 'At least one department or email domain is required for a dynamic group';
  }
  return null;
}

export function summarizeDynamicRule(rule: DynamicGroupRule): string {
  const depts = normList(rule.dept_ids);
  const domains = normDomains(rule.email_domains);
  const parts: string[] = [];
  if (depts.length) parts.push(`Department: ${depts.join(', ')}`);
  if (domains.length) parts.push(`Email domain: ${domains.map((d) => `@${d}`).join(', ')}`);
  if (!parts.length) return 'No rule configured';
  return parts.join(' · ');
}

function ruleHasCriteria(rule: DynamicGroupRule): boolean {
  return normList(rule.dept_ids).length > 0 || normDomains(rule.email_domains).length > 0;
}

/** Active directory users match department and/or email-domain rules. */
export function employeeMatchesDynamicRule(
  emp: Pick<EmployeeRow, 'dept_id' | 'email_corp' | 'ilg_state'>,
  rule: DynamicGroupRule,
): boolean {
  if (emp.ilg_state !== 'ACTIVE') return false;

  const depts = normList(rule.dept_ids).map((d) => d.toLowerCase());
  const domains = normDomains(rule.email_domains);

  if (depts.length) {
    const empDept = (emp.dept_id || '').trim().toLowerCase();
    if (!empDept || !depts.includes(empDept)) return false;
  }

  if (domains.length) {
    const empDomain = emailDomainOf(emp.email_corp);
    if (!empDomain || !domains.includes(empDomain)) return false;
  }

  return depts.length > 0 || domains.length > 0;
}

async function loadDynamicGroup(groupId: string): Promise<DynamicGroupRow | null> {
  const schemaReady = await isGroupSyncSchemaReady();
  const row = schemaReady
    ? await queryOne<DynamicGroupRow>(
        `SELECT id, name, type, rule_json, source_system, active
           FROM \`groups\`
          WHERE id = ? AND active = 1`,
        [groupId],
      )
    : await queryOne<Omit<DynamicGroupRow, 'source_system'> & { source_system?: string }>(
        `SELECT id, name, type, rule_json, active
           FROM \`groups\`
          WHERE id = ? AND active = 1`,
        [groupId],
      );
  if (!row) return null;
  return { ...row, source_system: row.source_system ?? 'LOCAL' };
}

async function listLocalDynamicGroupRows(): Promise<DynamicGroupRow[]> {
  const schemaReady = await isGroupSyncSchemaReady();
  if (schemaReady) {
    return query<DynamicGroupRow>(
      `SELECT id, name, type, rule_json, source_system, active
         FROM \`groups\`
        WHERE type = 'DYNAMIC' AND active = 1
          AND (source_system IS NULL OR source_system = 'LOCAL')`,
      [],
    );
  }
  const rows = await query<Omit<DynamicGroupRow, 'source_system'> & { source_system?: string }>(
    `SELECT id, name, type, rule_json, active
       FROM \`groups\`
      WHERE type = 'DYNAMIC' AND active = 1`,
    [],
  );
  return rows.map((r) => ({ ...r, source_system: 'LOCAL' }));
}

async function insertGroupMembersBatch(
  groupId: string,
  empIds: string[],
  addedBy: string | null,
): Promise<number> {
  if (!empIds.length) return 0;
  let added = 0;
  for (let i = 0; i < empIds.length; i += MEMBER_BATCH) {
    const chunk = empIds.slice(i, i + MEMBER_BATCH);
    const placeholders = chunk.map(() => '(?, ?, ?)').join(', ');
    const params: unknown[] = [];
    for (const empId of chunk) {
      params.push(groupId, empId, addedBy);
    }
    const header = await execute(
      `INSERT IGNORE INTO group_members (group_id, emp_id, added_by) VALUES ${placeholders}`,
      params,
    );
    added += header.affectedRows ?? 0;
  }
  return added;
}

async function deleteGroupMembersBatch(groupId: string, empIds: string[]): Promise<number> {
  if (!empIds.length) return 0;
  let removed = 0;
  for (let i = 0; i < empIds.length; i += MEMBER_BATCH) {
    const chunk = empIds.slice(i, i + MEMBER_BATCH);
    const placeholders = chunk.map(() => '?').join(', ');
    const header = await execute(
      `DELETE FROM group_members WHERE group_id = ? AND emp_id IN (${placeholders})`,
      [groupId, ...chunk],
    );
    removed += header.affectedRows ?? 0;
  }
  return removed;
}

async function isLocalDynamicGroup(groupId: string): Promise<boolean> {
  const row = await loadDynamicGroup(groupId);
  if (!row || row.type !== 'DYNAMIC') return false;
  const source = row.source_system ?? 'LOCAL';
  return source === 'LOCAL';
}

export async function listDistinctDepartments(): Promise<string[]> {
  const rows = await query<{ dept_id: string }>(
    `SELECT DISTINCT dept_id FROM employees
      WHERE dept_id IS NOT NULL AND TRIM(dept_id) != ''
      ORDER BY dept_id`,
    [],
  );
  return rows.map((r) => r.dept_id.trim()).filter(Boolean);
}

export async function listDistinctEmailDomains(): Promise<string[]> {
  const rows = await query<{ domain: string }>(
    `SELECT DISTINCT LOWER(TRIM(SUBSTRING_INDEX(email_corp, '@', -1))) AS domain
       FROM employees
      WHERE email_corp IS NOT NULL
        AND TRIM(email_corp) != ''
        AND email_corp LIKE '%@%'
      ORDER BY domain`,
    [],
  );
  return rows.map((r) => r.domain.trim()).filter(Boolean);
}

/** Add/remove one employee across all active local DYNAMIC groups. */
export async function reconcileDynamicGroupsForEmployee(
  empId: string,
  addedBy: string | null = null,
): Promise<{ added: number; removed: number }> {
  const emp = await queryOne<EmployeeRow>(
    `SELECT emp_id, dept_id, email_corp, ilg_state FROM employees WHERE emp_id = ?`,
    [empId],
  );
  if (!emp) return { added: 0, removed: 0 };

  const groups = await listLocalDynamicGroupRows();

  let added = 0;
  let removed = 0;

  for (const group of groups) {
    const rule = parseDynamicRule(group.rule_json);
    if (!ruleHasCriteria(rule)) continue;

    const shouldMember = employeeMatchesDynamicRule(emp, rule);
    const existing = await queryOne<{ emp_id: string }>(
      `SELECT emp_id FROM group_members WHERE group_id = ? AND emp_id = ? LIMIT 1`,
      [group.id, empId],
    );

    if (shouldMember && !existing) {
      await execute(
        `INSERT IGNORE INTO group_members (group_id, emp_id, added_by) VALUES (?, ?, ?)`,
        [group.id, empId, addedBy],
      );
      added += 1;
    } else if (!shouldMember && existing) {
      await execute(
        `DELETE FROM group_members WHERE group_id = ? AND emp_id = ?`,
        [group.id, empId],
      );
      removed += 1;
    }
  }

  if (added || removed) {
    logger.info({ empId, added, removed }, 'Reconciled dynamic group membership for employee');
  }

  return { added, removed };
}

async function queryMatchingEmployees(rule: DynamicGroupRule): Promise<EmployeeRow[]> {
  const depts = normList(rule.dept_ids).map((d) => d.toLowerCase());
  const domains = normDomains(rule.email_domains);

  const where: string[] = [`ilg_state = 'ACTIVE'`];
  const params: unknown[] = [];

  if (depts.length) {
    const placeholders = depts.map(() => '?').join(', ');
    where.push(`dept_id IS NOT NULL AND LOWER(TRIM(dept_id)) IN (${placeholders})`);
    params.push(...depts);
  }

  if (domains.length) {
    const domainClauses = domains.map(() => `LOWER(TRIM(SUBSTRING_INDEX(email_corp, '@', -1))) = ?`);
    where.push(`email_corp IS NOT NULL AND (${domainClauses.join(' OR ')})`);
    params.push(...domains);
  }

  return query<EmployeeRow>(
    `SELECT emp_id, dept_id, email_corp, ilg_state FROM employees WHERE ${where.join(' AND ')}`,
    params,
  );
}

/** Reconcile all employees for one dynamic group. */
export async function reconcileDynamicGroup(
  groupId: string,
  addedBy: string | null = null,
): Promise<{ added: number; removed: number; matched: number }> {
  const group = await loadDynamicGroup(groupId);
  if (!group || group.type !== 'DYNAMIC') {
    throw new Error('Group is not a dynamic group');
  }
  if ((group.source_system ?? 'LOCAL') !== 'LOCAL') {
    throw new Error('Only local dynamic groups can be reconciled from rules');
  }

  const rule = parseDynamicRule(group.rule_json);
  const ruleErr = validateDynamicRule(rule);
  if (ruleErr) throw new Error(ruleErr);

  const matching = await queryMatchingEmployees(rule);
  const matchSet = new Set(matching.map((e) => e.emp_id));

  const current = await query<{ emp_id: string }>(
    `SELECT emp_id FROM group_members WHERE group_id = ?`,
    [groupId],
  );
  const currentSet = new Set(current.map((m) => m.emp_id));

  const toAdd = [...matchSet].filter((empId) => !currentSet.has(empId));
  const toRemove = [...currentSet].filter((empId) => !matchSet.has(empId));

  const added = await insertGroupMembersBatch(groupId, toAdd, addedBy);
  const removed = await deleteGroupMembersBatch(groupId, toRemove);

  logger.info({ groupId, added, removed, matched: matchSet.size }, 'Reconciled dynamic group');
  return { added, removed, matched: matchSet.size };
}

/** Reconcile every active local dynamic group. */
export async function reconcileAllDynamicGroups(
  addedBy: string | null = null,
): Promise<{ groups: number; added: number; removed: number }> {
  const groups = await listLocalDynamicGroupRows();

  let added = 0;
  let removed = 0;

  for (const group of groups) {
    try {
      const result = await reconcileDynamicGroup(group.id, addedBy);
      added += result.added;
      removed += result.removed;
    } catch (err) {
      logger.warn({ err, groupId: group.id }, 'Dynamic group reconcile skipped');
    }
  }

  return { groups: groups.length, added, removed };
}

export async function assertNotDynamicGroup(groupId: string): Promise<void> {
  if (await isLocalDynamicGroup(groupId)) {
    throw new Error('Members of dynamic groups are managed automatically from department/domain rules');
  }
}
