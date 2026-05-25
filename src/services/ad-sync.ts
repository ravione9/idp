/**
 * AD Sync Service
 * ---------------
 * Full reconciliation sync between the IDP employee database and Active Directory.
 * - Provisions new AD users for ACTIVE employees with no AD identity link
 * - Disables AD accounts for SUSPENDED/TERMINATED employees
 * - Re-enables AD accounts for ACTIVE employees whose link is DISABLED
 * - Records all runs in connector_runs table
 */

import crypto from 'crypto';
import { ADAdapter, normalizeOuRdn } from '../adapters/ad-adapter.js';
import { query, queryOne, execute } from '../db/connection.js';
import { config } from '../config.js';
import { redis } from '../auth/session-store.js';
import logger from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Types
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
  dept_id: string | null;
  role: string | null;
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
function generateSamAccountName(fullName: string): string {
  const parts = fullName.toLowerCase().replace(/[^a-z\s]/g, '').trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.slice(0, 10) ?? 'user';
  const last = parts.length > 1 ? parts[parts.length - 1]?.slice(0, 9) ?? '' : '';
  let sam = last ? `${first}.${last}` : first;
  sam = sam.replace(/[^a-z0-9._-]/g, '').replace(/^\.+|\.+$/g, '');
  if (!sam) sam = 'user';
  return sam.slice(0, 20);
}

function generateTempPassword(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  let pw = '';
  const buf = crypto.randomBytes(16);
  for (let i = 0; i < 16; i++) {
    pw += chars[buf[i] % chars.length];
  }
  return pw;
}

// ---------------------------------------------------------------------------
// Main sync function
// ---------------------------------------------------------------------------
export async function runAdSync(connectorId: string): Promise<SyncResult> {
  const runId = uuidv4();

  // Create connector_runs record
  await execute(
    `INSERT INTO connector_runs
       (id, connector_id, run_type, status, started_at, items_processed, items_succeeded, items_failed)
     VALUES (?, ?, 'INCREMENTAL', 'RUNNING', UTC_TIMESTAMP(), 0, 0, 0)`,
    [runId, connectorId],
  );

  // ── Build ADAdapter from connector's stored config_json ──────────────────
  // Falls back to env vars so existing deployments keep working.
  const connRow = await queryOne<{ config_json: string | Record<string, unknown> }>(
    `SELECT config_json FROM connectors WHERE id = ?`,
    [connectorId],
  );
  const cfg: Record<string, unknown> =
    connRow
      ? typeof connRow.config_json === 'string'
        ? JSON.parse(connRow.config_json || '{}')
        : (connRow.config_json ?? {})
      : {};

  const host       = (cfg['host'] as string | undefined)?.trim()     || new URL(config.ad.url).hostname;
  const port       = Number(cfg['port'] ?? (cfg['useSsl'] ? 636 : 389));
  const useSsl     = cfg['useSsl'] !== undefined ? Boolean(cfg['useSsl']) : config.ad.url.startsWith('ldaps');
  const startTls   = cfg['startTls'] !== undefined ? Boolean(cfg['startTls']) : false;
  const bindDn     = (cfg['bindDn']       as string | undefined) || config.ad.bindDn;
  const bindPass   = (cfg['bindPassword'] as string | undefined) || config.ad.bindPassword;
  const baseDn     = (cfg['baseDn']       as string | undefined) || config.ad.baseDn;
  const upnDomain  = (cfg['upnDomain']    as string | undefined)?.trim()
                  || (cfg['customerDomain'] as string | undefined)?.trim()
                  || undefined;
  const targetOu   = normalizeOuRdn((cfg['targetOu'] as string | undefined) || 'OU=Employees');
  const adUrl      = `${useSsl ? 'ldaps' : 'ldap'}://${host}:${port}`;

  logger.info({ connectorId, adUrl, bindDn, baseDn, startTls }, 'AD sync: connecting');

  const adapter = new ADAdapter(
    redis,
    adUrl,
    bindDn,
    bindPass,
    baseDn,
    undefined,  // disabledOu — use default
    startTls,
    targetOu,
  );

  // Clear any OPEN circuit from a prior failed run so this sync gets a fresh attempt
  await adapter.resetCircuitBreaker();

  let itemsProcessed = 0;
  let itemsSucceeded = 0;
  let itemsFailed = 0;
  const errors: string[] = [];

  try {
    await adapter.connect();

    // Fetch all employees
    const employees = await query<EmployeeRow>(
      `SELECT emp_id, full_name, email_corp, dept_id, role, ilg_state
         FROM employees
        ORDER BY emp_id`,
      [],
    );

    if (!useSsl && !startTls) {
      const needsProvision = employees.some((e) =>
        e.ilg_state === 'ACTIVE' || e.ilg_state === 'REACTIVATED',
      );
      if (needsProvision) {
        throw new Error(
          'AD sync cannot provision users over plain LDAP. Set connector Protocol to LDAPS or LDAP+StartTLS.',
        );
      }
    }

    const needsProvisioning = await (async () => {
      for (const emp of employees) {
        if (emp.ilg_state !== 'ACTIVE' && emp.ilg_state !== 'REACTIVATED') continue;
        const link = await queryOne<{ id: number }>(
          `SELECT id FROM identity_links
            WHERE emp_id = ? AND \`system\` = 'AD' AND status NOT IN ('DELETED')`,
          [emp.emp_id],
        );
        if (!link) return true;
      }
      return false;
    })();

    if (needsProvisioning) {
      const ouCheck = await adapter.validateProvisioningOu(targetOu);
      if (!ouCheck.ok) {
        const hint = ouCheck.suggestions.length
          ? ` Existing OUs: ${ouCheck.suggestions.slice(0, 6).join('; ')}`
          : '';
        throw new Error(
          `Target OU does not exist: ${ouCheck.ouDn}. Create it in Active Directory or update connector "New User OU".${hint}`,
        );
      }
    }

    logger.info({ connectorId, runId, count: employees.length }, 'AD sync: processing employees');

    for (const emp of employees) {
      itemsProcessed++;

      try {
        // Look up existing identity link
        const link = await queryOne<IdentityLinkRow>(
          `SELECT id, external_id, status
             FROM identity_links
            WHERE emp_id = ? AND \`system\` = 'AD' AND status NOT IN ('DELETED')`,
          [emp.emp_id],
        );

        const isActive   = emp.ilg_state === 'ACTIVE' || emp.ilg_state === 'REACTIVATED';
        // Disable AD for hard-stop states; leave PENDING_MGR / ESCALATED_HRBP untouched
        const isInactive = emp.ilg_state === 'SUSPENDED_HR'
                        || emp.ilg_state === 'SUSPENDED_AUTO'
                        || emp.ilg_state === 'DEPARTED'
                        || emp.ilg_state === 'DEPROVISIONED';

        if (isActive && !link) {
          // ── Reconciliation: check if user already exists in AD ──────────────
          // Try by employeeID first; fall back to corporate email for accounts
          // that were created before LILG and don't have employeeID set yet.
          let existingSam: string | null = null;

          const byId = await adapter.getUser(emp.emp_id);
          if (byId.success) {
            existingSam = String((byId.data as Record<string, unknown>)['sAMAccountName'] ?? '');
          } else {
            const byMail = await adapter.getUserByEmail(emp.email_corp);
            if (byMail.success) {
              existingSam = String((byMail.data as Record<string, unknown>)['sAMAccountName'] ?? '');
            }
          }

          if (existingSam) {
            // Account already exists in AD — link it without re-provisioning
            await execute(
              `INSERT INTO identity_links (emp_id, \`system\`, external_id, status, auth_kind)
               VALUES (?, 'AD', ?, 'ACTIVE', 'LDAP')`,
              [emp.emp_id, existingSam],
            );
            logger.info({ empId: emp.emp_id, existingSam }, 'AD sync: existing AD user reconciled and linked');
            itemsSucceeded++;
          } else {
            // No AD account found — provision a new one
            const sAMAccountName = generateSamAccountName(emp.full_name);
            const tempPass = generateTempPassword();

            const result = await adapter.createUser({
              empId:        emp.emp_id,
              fullName:     emp.full_name,
              emailCorp:    emp.email_corp,
              sAMAccountName,
              department:   emp.dept_id ?? '',
              title:        emp.role ?? '',
              targetOu,
              ...(upnDomain ? { upnDomain } : {}),
              tempPassword: tempPass,
            });

            if (result.success) {
              await execute(
                `INSERT INTO identity_links (emp_id, \`system\`, external_id, status, auth_kind)
                 VALUES (?, 'AD', ?, 'ACTIVE', 'LDAP')`,
                [emp.emp_id, sAMAccountName],
              );
              logger.info({ empId: emp.emp_id, sAMAccountName }, 'AD sync: new user provisioned');
              itemsSucceeded++;
            } else {
              throw new Error(result.error ?? 'createUser failed');
            }
          }
        } else if (isInactive && link && link.status === 'ACTIVE') {
          // Disable AD account
          const result = await adapter.disable(link.external_id);
          if (result.success) {
            await execute(
              `UPDATE identity_links SET status = 'DISABLED' WHERE id = ?`,
              [link.id],
            );
            logger.info({ empId: emp.emp_id, externalId: link.external_id }, 'AD sync: user disabled');
            itemsSucceeded++;
          } else {
            throw new Error(result.error ?? 'disable failed');
          }
        } else if (isActive && link && link.status === 'DISABLED') {
          // Re-enable AD account
          const result = await adapter.enable(link.external_id);
          if (result.success) {
            await execute(
              `UPDATE identity_links SET status = 'ACTIVE' WHERE id = ?`,
              [link.id],
            );
            logger.info({ empId: emp.emp_id, externalId: link.external_id }, 'AD sync: user re-enabled');
            itemsSucceeded++;
          } else {
            throw new Error(result.error ?? 'enable failed');
          }
        } else {
          // No action needed
          itemsSucceeded++;
        }
      } catch (err) {
        itemsFailed++;
        const msg = `${emp.emp_id}: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(msg);
        logger.error({ empId: emp.emp_id, err }, 'AD sync: per-employee error (non-fatal)');
      }
    }

    await adapter.disconnect();
  } catch (fatalErr) {
    logger.error({ connectorId, runId, err: fatalErr }, 'AD sync: fatal error');
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
    'AD sync completed',
  );

  return { runId, connectorId, itemsProcessed, itemsSucceeded, itemsFailed, errors };
}
