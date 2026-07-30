/**
 * LILG — SAML app entitlement evaluation
 * Determines which registered SPs a user may access.
 */

import { roleAtLeast, type Role } from '../auth/rbac.js';
import type { EmployeeSamlContext, EntitlementRule, SamlServiceProviderRow } from './types.js';
import { SAML_ALLOWED_ILG_STATES } from './types.js';

export function canReceiveSamlAssertion(emp: EmployeeSamlContext): boolean {
  if (!SAML_ALLOWED_ILG_STATES.has(emp.ilg_state)) return false;
  if (emp.hrms_status !== 'ACTIVE') return false;
  return true;
}

export function evaluateEntitlement(
  emp: EmployeeSamlContext,
  rule: EntitlementRule | null,
): boolean {
  if (!canReceiveSamlAssertion(emp)) return false;

  const r = rule ?? { all_active: true };

  if (r.deny_ilg_states?.includes(emp.ilg_state)) return false;

  const hasRoleFilter       = (r.roles?.length ?? 0) > 0;
  const hasEmpTypeFilter    = (r.employment_types?.length ?? 0) > 0;
  const hasDeptFilter       = (r.dept_ids?.length ?? 0) > 0;

  if (!hasRoleFilter && !hasEmpTypeFilter && !hasDeptFilter) {
    return r.all_active !== false;
  }

  if (hasRoleFilter && r.roles!.some((role) => roleAtLeast(emp.role ?? 'EMPLOYEE', role as Role))) {
    return true;
  }

  if (hasEmpTypeFilter && r.employment_types!.includes(emp.employment_type)) {
    return true;
  }

  if (hasDeptFilter && emp.dept_id !== null && r.dept_ids!.includes(emp.dept_id)) {
    return true;
  }

  return false;
}

export function filterEntitledApps(
  emp: EmployeeSamlContext,
  apps: SamlServiceProviderRow[],
): SamlServiceProviderRow[] {
  return apps.filter((sp) => evaluateEntitlement(emp, sp.entitlement_rule));
}
