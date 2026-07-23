/**
 * Birthright Entitlement Service
 * ------------------------------
 * Assigns / revokes entitlements whose `is_birthright = 1` when the employee
 * matches each entitlement's `birthright_rule` JSON.
 *
 * Rule shape (all clauses AND; empty / null rule ⇒ all ACTIVE employees):
 *   {
 *     "dept_ids": ["IT","HR"],           // employees.dept_id IN …
 *     "employment_types": ["CORPORATE"], // employees.employment_type IN …
 *     "roles": ["Engineer"],             // employees.role IN …
 *     "group_ids": ["uuid…"],            // member of any listed group
 *     "exclude_dept_ids": ["CONTRACTORS"]
 *   }
 */

import { query, queryOne, execute } from '../db/connection.js';
import { triggerConnectorSync } from './connector-dispatcher.js';
import logger from '../utils/logger.js';

export interface BirthrightRule {
  dept_ids?: string[];
  employment_types?: string[];
  roles?: string[];
  group_ids?: string[];
  exclude_dept_ids?: string[];
  /** @deprecated prefer explicit filters; kept for UI compatibility */
  all_active?: boolean;
}

interface EntitlementRow {
  id: string;
  slug: string;
  name: string;
  app_id: string | null;
  connector_id: string | null;
  birthright_rule: unknown;
}

interface EmployeeCtx {
  emp_id: string;
  dept_id: string;
  role: string;
  employment_type: string;
  ilg_state: string;
  group_ids: Set<string>;
}

function parseRule(raw: unknown): BirthrightRule {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as BirthrightRule;
    } catch {
      return {};
    }
  }
  if (typeof raw === 'object') return raw as BirthrightRule;
  return {};
}

function normList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean);
}

/** True when the employee satisfies the rule (empty rule = match all ACTIVE). */
export function matchesBirthrightRule(emp: EmployeeCtx, rule: BirthrightRule): boolean {
  if (emp.ilg_state !== 'ACTIVE') return false;

  const exclude = normList(rule.exclude_dept_ids).map((d) => d.toLowerCase());
  if (exclude.length && emp.dept_id && exclude.includes(emp.dept_id.toLowerCase())) {
    return false;
  }

  const depts = normList(rule.dept_ids).map((d) => d.toLowerCase());
  if (depts.length && !depts.includes((emp.dept_id || '').toLowerCase())) {
    return false;
  }

  const types = normList(rule.employment_types).map((t) => t.toUpperCase());
  if (types.length && !types.includes((emp.employment_type || '').toUpperCase())) {
    return false;
  }

  const roles = normList(rule.roles).map((r) => r.toLowerCase());
  if (roles.length && !roles.includes((emp.role || '').toLowerCase())) {
    return false;
  }

  const groups = normList(rule.group_ids);
  if (groups.length && !groups.some((g) => emp.group_ids.has(g))) {
    return false;
  }

  return true;
}

export function summarizeRule(rule: BirthrightRule): string {
  const parts: string[] = [];
  const depts = normList(rule.dept_ids);
  const types = normList(rule.employment_types);
  const roles = normList(rule.roles);
  const groups = normList(rule.group_ids);
  const excl = normList(rule.exclude_dept_ids);
  if (depts.length) parts.push(`dept: ${depts.join(', ')}`);
  if (types.length) parts.push(`type: ${types.join(', ')}`);
  if (roles.length) parts.push(`role: ${roles.join(', ')}`);
  if (groups.length) parts.push(`groups: ${groups.length}`);
  if (excl.length) parts.push(`exclude dept: ${excl.join(', ')}`);
  return parts.length ? parts.join(' · ') : 'All ACTIVE employees';
}

async function loadEmployeeCtx(empId: string): Promise<EmployeeCtx | null> {
  const row = await queryOne<{
    emp_id: string;
    dept_id: string | null;
    role: string | null;
    employment_type: string | null;
    ilg_state: string;
  }>(
    `SELECT emp_id, dept_id, role, employment_type, ilg_state
       FROM employees WHERE emp_id = ? LIMIT 1`,
    [empId],
  );
  if (!row) return null;

  const groups = await query<{ group_id: string }>(
    `SELECT group_id FROM group_members WHERE emp_id = ?`,
    [empId],
  );

  return {
    emp_id: row.emp_id,
    dept_id: row.dept_id ?? '',
    role: row.role ?? '',
    employment_type: row.employment_type ?? '',
    ilg_state: row.ilg_state,
    group_ids: new Set(groups.map((g) => g.group_id)),
  };
}

async function listBirthrightEntitlements(): Promise<EntitlementRow[]> {
  return query<EntitlementRow>(
    `SELECT id, slug, name, app_id, connector_id, birthright_rule
       FROM entitlements
      WHERE is_birthright = 1 AND active = 1`,
    [],
  );
}

/** Entitlements this employee would receive (rule match, not yet granted). */
export async function dryRunBirthrightForEmployee(empId: string): Promise<EntitlementRow[]> {
  const emp = await loadEmployeeCtx(empId);
  if (!emp || emp.ilg_state !== 'ACTIVE') return [];

  const entitlements = await listBirthrightEntitlements();
  const matching = entitlements.filter((ent) => matchesBirthrightRule(emp, parseRule(ent.birthright_rule)));
  if (!matching.length) return [];

  const held = await query<{ entitlement_id: string }>(
    `SELECT entitlement_id FROM user_entitlements
      WHERE emp_id = ? AND revoked_at IS NULL`,
    [empId],
  );
  const heldSet = new Set(held.map((h) => h.entitlement_id));
  return matching.filter((e) => !heldSet.has(e.id));
}

/** Kick AD/Google outbound sync for connectors linked to newly granted entitlements. */
export async function kickConnectorProvision(
  connectorIds: Iterable<string>,
  triggeredBy: string,
): Promise<void> {
  const seen = new Set<string>();
  for (const connectorId of connectorIds) {
    if (!connectorId || seen.has(connectorId)) continue;
    seen.add(connectorId);
    try {
      await triggerConnectorSync(connectorId, triggeredBy);
    } catch (err) {
      logger.warn({ connectorId, triggeredBy, err }, 'Birthright: connector sync kick failed');
    }
  }
}

export interface AssignBirthrightResult {
  granted: number;
  connectorIds: string[];
}

// ---------------------------------------------------------------------------
// assignBirthrightEntitlements
// ---------------------------------------------------------------------------
export async function assignBirthrightEntitlements(
  empId: string,
  _department?: string,
  _role?: string,
  opts?: { provisionConnectors?: boolean },
): Promise<number> {
  const result = await assignBirthrightEntitlementsDetailed(empId, opts);
  return result.granted;
}

export async function assignBirthrightEntitlementsDetailed(
  empId: string,
  opts?: { provisionConnectors?: boolean },
): Promise<AssignBirthrightResult> {
  const emp = await loadEmployeeCtx(empId);
  if (!emp) {
    logger.warn({ empId }, 'Birthright: employee not found');
    return { granted: 0, connectorIds: [] };
  }
  if (emp.ilg_state !== 'ACTIVE') {
    logger.debug({ empId, state: emp.ilg_state }, 'Birthright: skip non-ACTIVE employee');
    return { granted: 0, connectorIds: [] };
  }

  const entitlements = await listBirthrightEntitlements();
  if (entitlements.length === 0) {
    logger.debug({ empId }, 'Birthright: no birthright entitlements configured');
    return { granted: 0, connectorIds: [] };
  }

  let granted = 0;
  const connectorsToKick = new Set<string>();

  for (const ent of entitlements) {
    const rule = parseRule(ent.birthright_rule);
    if (!matchesBirthrightRule(emp, rule)) continue;

    try {
      const result = await execute(
        `INSERT IGNORE INTO user_entitlements
           (emp_id, entitlement_id, source, granted_at)
         VALUES (?, ?, 'BIRTHRIGHT', UTC_TIMESTAMP())`,
        [empId, ent.id],
      );
      if (result.affectedRows > 0) {
        granted += result.affectedRows;
        if (ent.connector_id) connectorsToKick.add(ent.connector_id);
      }
    } catch (err) {
      logger.warn({ empId, entitlementId: ent.id, err }, 'Birthright: failed to grant entitlement');
    }
  }

  const connectorIds = [...connectorsToKick];
  if (opts?.provisionConnectors !== false && connectorIds.length > 0) {
    void kickConnectorProvision(connectorIds, `birthright:${empId}`);
  }

  logger.info({ empId, granted, total: entitlements.length }, 'Birthright entitlements assigned');
  return { granted, connectorIds };
}

// ---------------------------------------------------------------------------
// revokeBirthrightEntitlements
// ---------------------------------------------------------------------------
export async function revokeBirthrightEntitlements(empId: string): Promise<number> {
  const result = await execute(
    `UPDATE user_entitlements
        SET revoked_at = UTC_TIMESTAMP(), revoked_by = 'SYSTEM'
      WHERE emp_id = ? AND source = 'BIRTHRIGHT' AND revoked_at IS NULL`,
    [empId],
  );

  logger.info({ empId, revoked: result.affectedRows }, 'Birthright entitlements revoked');
  return result.affectedRows;
}

/** Reconcile: grant missing matches + revoke BIRTHRIGHT grants that no longer match. */
export async function reconcileBirthrightForEmployee(
  empId: string,
  opts?: { provisionConnectors?: boolean },
): Promise<{ granted: number; revoked: number; connectorIds: string[] }> {
  const assigned = await assignBirthrightEntitlementsDetailed(empId, {
    provisionConnectors: opts?.provisionConnectors ?? false,
  });
  const granted = assigned.granted;

  const emp = await loadEmployeeCtx(empId);
  if (!emp) return { granted, revoked: 0, connectorIds: assigned.connectorIds };

  const held = await query<{ id: number; entitlement_id: string; birthright_rule: unknown }>(
    `SELECT ue.id, ue.entitlement_id, ent.birthright_rule
       FROM user_entitlements ue
       JOIN entitlements ent ON ent.id = ue.entitlement_id
      WHERE ue.emp_id = ? AND ue.source = 'BIRTHRIGHT' AND ue.revoked_at IS NULL
        AND ent.is_birthright = 1 AND ent.active = 1`,
    [empId],
  );

  let revoked = 0;
  for (const row of held) {
    if (matchesBirthrightRule(emp, parseRule(row.birthright_rule))) continue;
    const r = await execute(
      `UPDATE user_entitlements
          SET revoked_at = UTC_TIMESTAMP(), revoked_by = 'SYSTEM',
              revoke_reason = 'birthright_rule_no_longer_matches'
        WHERE id = ? AND revoked_at IS NULL`,
      [row.id],
    );
    revoked += r.affectedRows;
  }

  return { granted, revoked, connectorIds: assigned.connectorIds };
}
