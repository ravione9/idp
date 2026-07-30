/**
 * SoD Evaluator
 * -------------
 * Evaluates Segregation of Duties (SoD) policies against a proposed entitlement grant
 * or scans all employees for existing violations.
 *
 * conflict_groups is a JSON array of arrays of entitlement IDs.
 * A violation occurs when an employee holds at least one entitlement from EVERY group.
 */

import { query, execute } from '../db/connection.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface ViolationSummary {
  policyId: string;
  policyName: string;
  severity: string;
  conflictingEntitlements: string[];
}

export interface SodCheckResult {
  hasViolation: boolean;
  violations: ViolationSummary[];
}

interface SodPolicy {
  id: string;
  name: string;
  severity: string;
  enforcement: string;
  conflict_groups: string; // JSON string
}

// ---------------------------------------------------------------------------
// evaluateSodForGrant
// ---------------------------------------------------------------------------
export async function evaluateSodForGrant(
  empId: string,
  entitlementId: string,
): Promise<SodCheckResult> {
  // Load active SoD policies
  const policies = await query<SodPolicy>(
    `SELECT id, name, severity, enforcement, conflict_groups
       FROM sod_policies
      WHERE active = 1`,
    [],
  );

  // Load employee's current entitlement IDs
  const currentRows = await query<{ entitlement_id: string }>(
    `SELECT entitlement_id FROM user_entitlements WHERE emp_id = ? AND revoked_at IS NULL`,
    [empId],
  );

  const currentSet = new Set(currentRows.map((r) => r.entitlement_id));
  // Add the tentative new entitlement
  const tentativeSet = new Set([...currentSet, entitlementId]);

  const violations: ViolationSummary[] = [];

  for (const policy of policies) {
    let groups: string[][];
    try {
      groups = JSON.parse(policy.conflict_groups) as string[][];
    } catch {
      logger.warn({ policyId: policy.id }, 'SoD: failed to parse conflict_groups, skipping policy');
      continue;
    }

    if (!Array.isArray(groups) || groups.length < 2) {
      continue;
    }

    // Violation: tentative set contains at least one entitlement from EVERY group
    // AND the new entitlement must be involved (otherwise this was a pre-existing violation)
    const allGroupsCovered = groups.every((group) =>
      group.some((entId) => tentativeSet.has(entId)),
    );

    if (allGroupsCovered) {
      // Check if the new entitlement is involved
      const newEntInvolved = groups.some((group) => group.includes(entitlementId));

      if (newEntInvolved) {
        // Collect the conflicting entitlements (intersection with tentative set across all groups)
        const conflictingEntitlements: string[] = groups.flatMap((group) =>
          group.filter((entId) => tentativeSet.has(entId)),
        );

        violations.push({
          policyId:               policy.id,
          policyName:             policy.name,
          severity:               policy.severity,
          conflictingEntitlements: [...new Set(conflictingEntitlements)],
        });

        // Insert violation record (INSERT IGNORE to avoid duplicates)
        try {
          await execute(
            `INSERT IGNORE INTO sod_violations
               (id, policy_id, emp_id, conflicting_ents, status, detected_at)
             VALUES (?, ?, ?, ?, 'OPEN', UTC_TIMESTAMP())`,
            [
              uuidv4(),
              policy.id,
              empId,
              JSON.stringify(conflictingEntitlements),
            ],
          );
        } catch (insertErr) {
          logger.warn({ empId, policyId: policy.id, insertErr }, 'SoD: failed to insert violation record');
        }
      }
    }
  }

  return {
    hasViolation: violations.length > 0,
    violations,
  };
}

// ---------------------------------------------------------------------------
// scanAllSodViolations
// ---------------------------------------------------------------------------
export async function scanAllSodViolations(): Promise<number> {
  const policies = await query<SodPolicy>(
    `SELECT id, name, severity, enforcement, conflict_groups
       FROM sod_policies
      WHERE active = 1`,
    [],
  );

  if (policies.length === 0) {
    return 0;
  }

  // Load all user entitlements grouped by employee
  const allEntitlements = await query<{ emp_id: string; entitlement_id: string }>(
    `SELECT emp_id, entitlement_id FROM user_entitlements WHERE revoked_at IS NULL`,
    [],
  );

  // Group by emp_id
  const empEntMap = new Map<string, Set<string>>();
  for (const row of allEntitlements) {
    if (!empEntMap.has(row.emp_id)) {
      empEntMap.set(row.emp_id, new Set());
    }
    empEntMap.get(row.emp_id)!.add(row.entitlement_id);
  }

  let newViolationsCount = 0;

  for (const [empId, entitlements] of empEntMap.entries()) {
    for (const policy of policies) {
      let groups: string[][];
      try {
        groups = JSON.parse(policy.conflict_groups) as string[][];
      } catch {
        continue;
      }

      if (!Array.isArray(groups) || groups.length < 2) {
        continue;
      }

      const allGroupsCovered = groups.every((group) =>
        group.some((entId) => entitlements.has(entId)),
      );

      if (allGroupsCovered) {
        const conflictingEntitlements = groups.flatMap((group) =>
          group.filter((entId) => entitlements.has(entId)),
        );

        try {
          const result = await execute(
            `INSERT IGNORE INTO sod_violations
               (id, policy_id, emp_id, conflicting_ents, status, detected_at)
             VALUES (?, ?, ?, ?, 'OPEN', UTC_TIMESTAMP())`,
            [
              uuidv4(),
              policy.id,
              empId,
              JSON.stringify([...new Set(conflictingEntitlements)]),
            ],
          );
          newViolationsCount += result.affectedRows;
        } catch (insertErr) {
          logger.warn({ empId, policyId: policy.id, insertErr }, 'SoD scan: failed to insert violation');
        }
      }
    }
  }

  logger.info({ newViolationsCount }, 'SoD full scan completed');
  return newViolationsCount;
}
