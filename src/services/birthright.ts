/**
 * Birthright Entitlement Service
 * --------------------------------
 * Assigns and revokes birthright entitlements for employees.
 * Birthright entitlements are automatically granted based on employment status.
 */

import { query, execute } from '../db/connection.js';
import logger from '../utils/logger.js';

interface EntitlementRow {
  id: string;
  slug: string;
  name: string;
  app_id: string;
}

// ---------------------------------------------------------------------------
// assignBirthrightEntitlements
// ---------------------------------------------------------------------------
export async function assignBirthrightEntitlements(
  empId: string,
  _department: string,
  _role: string,
): Promise<number> {
  // Fetch all active birthright entitlements
  const entitlements = await query<EntitlementRow>(
    `SELECT id, slug, name, app_id FROM entitlements WHERE is_birthright = 1 AND active = 1`,
    [],
  );

  if (entitlements.length === 0) {
    logger.debug({ empId }, 'Birthright: no birthright entitlements configured');
    return 0;
  }

  let granted = 0;

  for (const ent of entitlements) {
    try {
      // id is BIGINT AUTO_INCREMENT — let MySQL assign it.
      const result = await execute(
        `INSERT IGNORE INTO user_entitlements
           (emp_id, entitlement_id, source, granted_at)
         VALUES (?, ?, 'BIRTHRIGHT', UTC_TIMESTAMP())`,
        [empId, ent.id],
      );
      granted += result.affectedRows;
    } catch (err) {
      logger.warn({ empId, entitlementId: ent.id, err }, 'Birthright: failed to grant entitlement');
    }
  }

  logger.info({ empId, granted, total: entitlements.length }, 'Birthright entitlements assigned');
  return granted;
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