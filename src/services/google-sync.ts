/**
 * Google Workspace Sync Service
 * ------------------------------
 * Full reconciliation sync between the IDP employee database and Google Workspace.
 * - Provisions new Google users for ACTIVE employees with no Google identity link
 * - Suspends Google accounts for SUSPENDED/TERMINATED employees
 * - Un-suspends Google accounts for ACTIVE employees whose link is DISABLED
 * - Records all runs in connector_runs table
 */

import crypto from 'crypto';
import { google } from 'googleapis';
import type { JWT } from 'google-auth-library';
import { query, queryOne, execute } from '../db/connection.js';
import { config } from '../config.js';
import logger from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Re-export SyncResult type (same shape as ad-sync)
// ---------------------------------------------------------------------------
export interface SyncResult {
  runId: string;
  connectorId: string;
  itemsProcessed: number;
  itemsSucceeded: number;
  itemsFailed: number;
  errors: string[];
}

interface EmployeeRow {
  emp_id: string;
  full_name: string;
  email_corp: string;
  department: string | null;
  title: string | null;
  role: string;
  ilg_state: string;
}

interface IdentityLinkRow {
  id: number;
  external_id: string;
  status: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function generateTempPassword(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  let pw = '';
  const buf = crypto.randomBytes(16);
  for (let i = 0; i < 16; i++) {
    pw += chars[buf[i] % chars.length];
  }
  return pw;
}

function parseNameParts(fullName: string): { givenName: string; familyName: string } {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) {
    return { givenName: parts[0], familyName: '.' };
  }
  const givenName = parts[0];
  const familyName = parts.slice(1).join(' ');
  return { givenName, familyName };
}

function buildJwtAuth(saKeyJson: string): JWT {
  let key: Record<string, string>;
  try {
    key = JSON.parse(saKeyJson) as Record<string, string>;
  } catch {
    key = JSON.parse(Buffer.from(saKeyJson, 'base64').toString('utf8')) as Record<string, string>;
  }

  return new google.auth.JWT({
    email:   key['client_email'],
    key:     key['private_key'],
    scopes:  [
      'https://www.googleapis.com/auth/admin.directory.user',
    ],
    subject: key['client_email'],
  });
}

// ---------------------------------------------------------------------------
// Main sync function
// ---------------------------------------------------------------------------
export async function runGoogleSync(connectorId: string): Promise<SyncResult> {
  const runId = uuidv4();

  // Create connector_runs record
  await execute(
    `INSERT INTO connector_runs
       (id, connector_id, run_type, status, started_at, items_processed, items_succeeded, items_failed)
     VALUES (?, ?, 'INCREMENTAL', 'RUNNING', UTC_TIMESTAMP(), 0, 0, 0)`,
    [runId, connectorId],
  );

  const auth = buildJwtAuth(config.google.saKeyJson);
  const directory = google.admin({ version: 'directory_v1', auth });

  let itemsProcessed = 0;
  let itemsSucceeded = 0;
  let itemsFailed = 0;
  const errors: string[] = [];

  try {
    // Fetch all employees
    const employees = await query<EmployeeRow>(
      `SELECT emp_id, full_name, email_corp, department, title, role, ilg_state
         FROM employees
        ORDER BY emp_id`,
      [],
    );

    logger.info({ connectorId, runId, count: employees.length }, 'Google sync: processing employees');

    for (const emp of employees) {
      itemsProcessed++;

      try {
        // Look up existing identity link
        const link = await queryOne<IdentityLinkRow>(
          `SELECT id, external_id, status
             FROM identity_links
            WHERE emp_id = ? AND \`system\` = 'GOOGLE' AND status NOT IN ('DELETED')`,
          [emp.emp_id],
        );

        const isActive   = emp.ilg_state === 'ACTIVE' || emp.ilg_state === 'REACTIVATED';
        const isInactive = emp.ilg_state === 'SUSPENDED_HR'
                        || emp.ilg_state === 'SUSPENDED_AUTO'
                        || emp.ilg_state === 'DEPARTED'
                        || emp.ilg_state === 'DEPROVISIONED';

        if (isActive && !link) {
          // Provision new Google user
          const { givenName, familyName } = parseNameParts(emp.full_name);
          const tempPass = generateTempPassword();

          const res = await directory.users.insert({
            requestBody: {
              primaryEmail: emp.email_corp,
              name: { givenName, familyName },
              password: tempPass,
              changePasswordAtNextLogin: true,
              orgUnitPath: '/Employees',
            },
          });

          const googleId = res.data.id ?? emp.email_corp;

          await execute(
            `INSERT INTO identity_links (emp_id, \`system\`, external_id, status, auth_kind)
             VALUES (?, 'GOOGLE', ?, 'ACTIVE', 'GOOGLE_OAUTH')`,
            [emp.emp_id, googleId],
          );

          logger.info({ empId: emp.emp_id, googleId }, 'Google sync: user provisioned');
          itemsSucceeded++;
        } else if (isInactive && link && link.status === 'ACTIVE') {
          // Suspend Google account
          await directory.users.update({
            userKey:     link.external_id,
            requestBody: { suspended: true },
          });

          await execute(
            `UPDATE identity_links SET status = 'DISABLED', updated_at = UTC_TIMESTAMP() WHERE id = ?`,
            [link.id],
          );

          logger.info({ empId: emp.emp_id, externalId: link.external_id }, 'Google sync: user suspended');
          itemsSucceeded++;
        } else if (isActive && link && link.status === 'DISABLED') {
          // Un-suspend Google account
          await directory.users.update({
            userKey:     link.external_id,
            requestBody: { suspended: false },
          });

          await execute(
            `UPDATE identity_links SET status = 'ACTIVE', updated_at = UTC_TIMESTAMP() WHERE id = ?`,
            [link.id],
          );

          logger.info({ empId: emp.emp_id, externalId: link.external_id }, 'Google sync: user re-enabled');
          itemsSucceeded++;
        } else {
          // No action needed
          itemsSucceeded++;
        }
      } catch (err) {
        itemsFailed++;
        const msg = `${emp.emp_id}: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(msg);
        logger.error({ empId: emp.emp_id, err }, 'Google sync: per-employee error (non-fatal)');
      }
    }
  } catch (fatalErr) {
    logger.error({ connectorId, runId, err: fatalErr }, 'Google sync: fatal error');
    await execute(
      `UPDATE connector_runs
          SET status = 'FAILED', ended_at = UTC_TIMESTAMP(),
              items_processed = ?, items_succeeded = ?, items_failed = ?,
              error_summary = ?
        WHERE id = ?`,
      [itemsProcessed, itemsSucceeded, itemsFailed, String(fatalErr), runId],
    );
    throw fatalErr;
  }

  const finalStatus = itemsFailed > 0 ? 'PARTIAL' : 'SUCCESS';
  const errorSummary = errors.length > 0 ? errors.slice(0, 10).join('; ') : null;

  await execute(
    `UPDATE connector_runs
        SET status = ?, ended_at = UTC_TIMESTAMP(),
            items_processed = ?, items_succeeded = ?, items_failed = ?,
            error_summary = ?
      WHERE id = ?`,
    [finalStatus, itemsProcessed, itemsSucceeded, itemsFailed, errorSummary, runId],
  );

  await execute(
    `UPDATE connectors SET last_sync_at = UTC_TIMESTAMP(), last_error = NULL WHERE id = ?`,
    [connectorId],
  );

  logger.info(
    { connectorId, runId, itemsProcessed, itemsSucceeded, itemsFailed, finalStatus },
    'Google sync completed',
  );

  return { runId, connectorId, itemsProcessed, itemsSucceeded, itemsFailed, errors };
}
