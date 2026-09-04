/**
 * Dynamic group membership — department-based rules on local DYNAMIC groups.
 *
 * Rule shape (stored in groups.rule_json):
 *   { "dept_ids": ["Engineering", "IT"] }
 * or legacy:
 *   { "field": "dept_id", "op": "eq"|"in", "value": "Engineering" }
 *   { "field": "dept_id", "op": "in", "value": ["Engineering", "IT"] }
 */
import { query, queryOne, execute } from '../db/connection.js';
import logger from '../utils/logger.js';

export interface DynamicGroupRule {
  dept_ids?: string[];
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
  ilg_state: string;
}

function normList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean);
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

  const deptIds = normList(obj.dept_ids);
  if (deptIds.length) return { dept_ids: deptIds };

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

export function buildDynamicRule(deptIds: string[]): DynamicGroupRule {
  const cleaned = normList(deptIds);
  return { dept_ids: cleaned };
}

export function validateDynamicRule(rule: DynamicGroupRule): string | null {
  const depts = normList(rule.dept_ids);
  if (!depts.length) {
    return 'At least one department is required for a dynamic group';
  }
  return null;
}

export function summarizeDynamicRule(rule: DynamicGroupRule): string {
  const depts = normList(rule.dept_ids);
  if (!depts.length) return 'No rule configured';
  return `Department: ${depts.join(', ')}`;
}

/** Active directory users match department rules. */
export function employeeMatchesDynamicRule(
  emp: Pick<EmployeeRow, 'dept_id' | 'ilg_state'>,
  rule: DynamicGroupRule,
): boolean {
  if (emp.ilg_state !== 'ACTIVE') return false;

  const depts = normList(rule.dept_ids).map((d) => d.toLowerCase());
  if (!depts.length) return false;

  const empDept = (emp.dept_id || '').trim().toLowerCase();
  if (!empDept) return false;

  return depts.includes(empDept);
}

async function loadDynamicGroup(groupId: string): Promise<DynamicGroupRow | null> {
  return queryOne<DynamicGroupRow>(
    `SELECT id, name, type, rule_json, source_system, active
       FROM \`groups\`
      WHERE id = ? AND active = 1`,
    [groupId],
  );
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

/** Add/remove one employee across all active local DYNAMIC groups. */
export async function reconcileDynamicGroupsForEmployee(
  empId: string,
  addedBy: string | null = null,
): Promise<{ added: number; removed: number }> {
  const emp = await queryOne<EmployeeRow>(
    `SELECT emp_id, dept_id, ilg_state FROM employees WHERE emp_id = ?`,
    [empId],
  );
  if (!emp) return { added: 0, removed: 0 };

  const groups = await query<DynamicGroupRow>(
    `SELECT id, name, type, rule_json, source_system, active
       FROM \`groups\`
      WHERE type = 'DYNAMIC' AND active = 1
        AND (source_system IS NULL OR source_system = 'LOCAL')`,
    [],
  );

  let added = 0;
  let removed = 0;

  for (const group of groups) {
    const rule = parseDynamicRule(group.rule_json);
    if (!normList(rule.dept_ids).length) continue;

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

  const depts = normList(rule.dept_ids).map((d) => d.toLowerCase());
  const placeholders = depts.map(() => '?').join(', ');

  const matching = await query<EmployeeRow>(
    `SELECT emp_id, dept_id, ilg_state FROM employees
      WHERE ilg_state = 'ACTIVE'
        AND dept_id IS NOT NULL
        AND LOWER(TRIM(dept_id)) IN (${placeholders})`,
    depts,
  );
  const matchSet = new Set(matching.map((e) => e.emp_id));

  const current = await query<{ emp_id: string }>(
    `SELECT emp_id FROM group_members WHERE group_id = ?`,
    [groupId],
  );
  const currentSet = new Set(current.map((m) => m.emp_id));

  let added = 0;
  let removed = 0;

  for (const empId of matchSet) {
    if (!currentSet.has(empId)) {
      await execute(
        `INSERT IGNORE INTO group_members (group_id, emp_id, added_by) VALUES (?, ?, ?)`,
        [groupId, empId, addedBy],
      );
      added += 1;
    }
  }

  for (const empId of currentSet) {
    if (!matchSet.has(empId)) {
      await execute(
        `DELETE FROM group_members WHERE group_id = ? AND emp_id = ?`,
        [groupId, empId],
      );
      removed += 1;
    }
  }

  logger.info({ groupId, added, removed, matched: matchSet.size }, 'Reconciled dynamic group');
  return { added, removed, matched: matchSet.size };
}

/** Reconcile every active local dynamic group. */
export async function reconcileAllDynamicGroups(
  addedBy: string | null = null,
): Promise<{ groups: number; added: number; removed: number }> {
  const groups = await query<{ id: string }>(
    `SELECT id FROM \`groups\`
      WHERE type = 'DYNAMIC' AND active = 1
        AND (source_system IS NULL OR source_system = 'LOCAL')`,
    [],
  );

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
    throw new Error('Members of dynamic groups are managed automatically from department rules');
  }
}
