/**
 * Google Workspace Sync Service
 * ------------------------------
 * INBOUND  — import Google Workspace users into employees + identity_links (match by email)
 * OUTBOUND — provision / suspend / re-enable Google accounts for IdP employees
 * BIDIRECTIONAL — both phases (default connector direction)
 */

import crypto from 'crypto';
import type { admin_directory_v1 } from 'googleapis';
import { google } from 'googleapis';
import { query, queryOne, execute } from '../db/connection.js';
import logger from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';
import {
  buildGoogleJwtAuth,
  employeeEligibleForGoogleOutbound,
  listScopedGoogleUsers,
  resolveGoogleSyncScope,
  type GoogleSyncScope,
} from './google-directory-config.js';
import { syncGoogleDirectoryGroups } from './group-sync.js';
import {
  applyAttrsToEmployee,
  extractGoogleAttrs,
  getGoogleSyncSettings,
  writeDirectoryUserAudit,
  type DirectoryAttrMapRow,
  type ExtractedAttrs,
  type GoogleSyncSettings,
  listGoogleAttrMaps,
} from './google-attr-map.js';

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

function deriveEmpIdFromGoogle(gUser: admin_directory_v1.Schema$User): string {
  const extId = gUser.id ?? gUser.primaryEmail ?? 'user';
  const hash = crypto.createHash('md5').update(extId).digest('hex').slice(0, 12).toUpperCase();
  return `GW-${hash}`;
}

/** Insert or revive a Google identity link (handles soft-deleted rows on uk_system_external). */
async function upsertGoogleIdentityLink(empId: string, googleId: string, linkStatus: string): Promise<void> {
  await execute(
    `INSERT INTO identity_links (emp_id, \`system\`, external_id, status, auth_kind, last_synced_at)
     VALUES (?, 'GOOGLE', ?, ?, 'OIDC', UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE
       emp_id = VALUES(emp_id),
       status = VALUES(status),
       auth_kind = VALUES(auth_kind),
       last_synced_at = UTC_TIMESTAMP()`,
    [empId, googleId, linkStatus],
  );
}

async function insertEmployeeFromGoogleAttrs(
  empId: string,
  email: string,
  ilgState: string,
  attrs: ExtractedAttrs,
): Promise<void> {
  const fullName = attrs.full_name || email.split('@')[0] || email;
  await execute(
    `INSERT INTO employees
       (emp_id, employee_number, full_name, first_name, last_name, email_corp,
        dept_id, role, cost_center, location, mobile, office_address, photo_url,
        ilg_state, hrms_status, hire_date, employment_type, sync_status, attrs_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', UTC_DATE(), 'CORPORATE', 'SYNCED', UTC_TIMESTAMP())`,
    [
      empId,
      attrs.employee_number ?? null,
      fullName,
      attrs.first_name ?? null,
      attrs.last_name ?? null,
      email,
      attrs.dept_id ?? null,
      attrs.role ?? null,
      attrs.cost_center ?? null,
      attrs.location ?? null,
      attrs.mobile ?? null,
      attrs.office_address ?? null,
      attrs.photo_url ?? null,
      ilgState,
    ],
  );
}

/** Prefer Google employeeId as emp_id when short/unique; else GW- hash. */
function preferEmpId(gUser: admin_directory_v1.Schema$User, attrs: ExtractedAttrs): string {
  const raw = (attrs.employee_number || '').trim();
  if (raw && raw.length <= 20 && /^[A-Za-z0-9._-]+$/.test(raw)) {
    return raw;
  }
  return deriveEmpIdFromGoogle(gUser);
}

/** Import Google Workspace users into employees + identity_links (merge by email). */
async function importGoogleDirectoryUsers(
  directory: admin_directory_v1.Admin,
  scope: GoogleSyncScope,
  errors: string[],
  opts: { runType?: 'INCREMENTAL' | 'FULL_SYNC'; disableDeleted?: boolean } = {},
): Promise<{
  found: number;
  imported: number;
  linked: number;
  updated: number;
  skipped: number;
  processed: number;
  succeeded: number;
  failed: number;
  disabled: number;
  repaired: number;
  notFoundEmails: string[];
}> {
  const scoped = await listScopedGoogleUsers(directory, scope);
  const googleUsers = scoped.users;
  for (const email of scoped.notFoundEmails) {
    errors.push(`Google user not found: ${email}`);
  }
  let imported = 0;
  let linked = 0;
  let updated = 0;
  let skipped = 0;
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let disabled = 0;

  let attrMaps: DirectoryAttrMapRow[] = [];
  let syncSettings: GoogleSyncSettings;
  try {
    attrMaps = await listGoogleAttrMaps();
    syncSettings = await getGoogleSyncSettings();
  } catch (err) {
    logger.warn({ err }, 'Google sync: attribute map/settings fallback to defaults');
    syncSettings = await getGoogleSyncSettings();
  }

  const disableDeleted = opts.disableDeleted ?? !!syncSettings.disable_deleted;

  logger.info(
    {
      count: googleUsers.length,
      orgUnits: scope.orgUnits,
      groups: scope.groups,
      users: scope.users.length,
      includeSubOrgUnits: scope.includeSubOrgUnits,
      runType: opts.runType ?? 'INCREMENTAL',
    },
    'Google sync inbound: listing scoped directory users',
  );

  const seenGoogleIds = new Set<string>();

  for (const gUser of googleUsers) {
    processed++;
    const email = (gUser.primaryEmail ?? '').trim().toLowerCase();
    const googleId = gUser.id ?? email;

    try {
      if (!email || !googleId) {
        skipped++;
        succeeded++;
        continue;
      }
      seenGoogleIds.add(googleId);

      const attrs = await extractGoogleAttrs(gUser, attrMaps, syncSettings);
      const fullName = attrs.full_name || email.split('@')[0] || email;
      const suspended = gUser.suspended === true;

      const existingLink = await queryOne<{ id: number; emp_id: string }>(
        `SELECT id, emp_id FROM identity_links WHERE \`system\` = 'GOOGLE' AND external_id = ?`,
        [googleId],
      );

      if (suspended) {
        const targetEmpId = existingLink?.emp_id
          ?? (await queryOne<{ emp_id: string }>(`SELECT emp_id FROM employees WHERE email_corp = ?`, [email]))?.emp_id;
        if (targetEmpId) {
          await upsertGoogleIdentityLink(targetEmpId, googleId, 'DISABLED');
          await execute(
            `UPDATE employees SET full_name = ?, ilg_state = 'SUSPENDED_AUTO', sync_status = 'DISABLED',
                    updated_at = UTC_TIMESTAMP() WHERE emp_id = ?`,
            [fullName, targetEmpId],
          );
          await applyAttrsToEmployee(targetEmpId, attrs, { syncSettings });
          linked++;
          disabled++;
        }
        skipped++;
        succeeded++;
        continue;
      }

      const linkStatus = 'ACTIVE';
      const ilgState = 'ACTIVE';

      if (existingLink) {
        await upsertGoogleIdentityLink(existingLink.emp_id, googleId, linkStatus);
        await execute(
          `UPDATE employees SET ilg_state = ?, updated_at = UTC_TIMESTAMP() WHERE emp_id = ?`,
          [ilgState, existingLink.emp_id],
        );
        const applied = await applyAttrsToEmployee(existingLink.emp_id, attrs, { syncSettings });
        if (applied.updated) {
          updated++;
          await writeDirectoryUserAudit({
            empId: existingLink.emp_id,
            action: 'GOOGLE_SYNC_UPDATE',
            source: 'GOOGLE',
            changedFields: Object.keys(applied.changes),
            oldValues: Object.fromEntries(Object.entries(applied.changes).map(([k, v]) => [k, v.old])),
            newValues: Object.fromEntries(Object.entries(applied.changes).map(([k, v]) => [k, v.new])),
          });
        }
        linked++;
        succeeded++;
        continue;
      }

      let empId = preferEmpId(gUser, attrs);
      const byEmail = await queryOne<{ emp_id: string }>(
        `SELECT emp_id FROM employees WHERE email_corp = ?`,
        [email],
      );
      const byEmpId = await queryOne<{ emp_id: string }>(
        `SELECT emp_id FROM employees WHERE emp_id = ?`,
        [empId],
      );
      const byEmpNumber = attrs.employee_number
        ? await queryOne<{ emp_id: string }>(
          `SELECT emp_id FROM employees WHERE employee_number = ? LIMIT 1`,
          [attrs.employee_number],
        )
        : null;

      if (byEmail) {
        empId = byEmail.emp_id;
        await execute(
          `UPDATE employees SET ilg_state = ?, updated_at = UTC_TIMESTAMP() WHERE emp_id = ?`,
          [ilgState, empId],
        );
        const applied = await applyAttrsToEmployee(empId, attrs, { syncSettings });
        if (applied.updated) updated++;
        linked++;
      } else if (byEmpNumber) {
        empId = byEmpNumber.emp_id;
        await execute(
          `UPDATE employees SET email_corp = ?, ilg_state = ?, updated_at = UTC_TIMESTAMP() WHERE emp_id = ?`,
          [email, ilgState, empId],
        );
        const applied = await applyAttrsToEmployee(empId, attrs, { syncSettings });
        if (applied.updated) updated++;
        linked++;
      } else if (byEmpId) {
        await execute(
          `UPDATE employees SET email_corp = ?, ilg_state = ?, updated_at = UTC_TIMESTAMP() WHERE emp_id = ?`,
          [email, ilgState, empId],
        );
        const applied = await applyAttrsToEmployee(empId, attrs, { syncSettings });
        if (applied.updated) updated++;
        linked++;
      } else {
        await insertEmployeeFromGoogleAttrs(empId, email, ilgState, attrs);
        if (attrs.manager_email) {
          await applyAttrsToEmployee(empId, attrs, { syncSettings });
        }
        imported++;
        await writeDirectoryUserAudit({
          empId,
          action: 'GOOGLE_SYNC_CREATE',
          source: 'GOOGLE',
          newValues: { email, ...attrs },
        });
      }

      await upsertGoogleIdentityLink(empId, googleId, linkStatus);
      succeeded++;
    } catch (err) {
      failed++;
      const msg = `${email || googleId}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      logger.error({ email, googleId, err }, 'Google sync inbound: user import failed');
    }
  }

  // Optional: disable local Google-linked users missing from this full sync scope
  if (disableDeleted && (opts.runType === 'FULL_SYNC' || scope.users.length === 0)) {
    const linkedRows = await query<{ emp_id: string; external_id: string }>(
      `SELECT emp_id, external_id FROM identity_links
        WHERE \`system\` = 'GOOGLE' AND status = 'ACTIVE'`,
      [],
    );
    for (const row of linkedRows) {
      if (seenGoogleIds.has(row.external_id)) continue;
      try {
        await execute(
          `UPDATE identity_links SET status = 'DISABLED', last_synced_at = UTC_TIMESTAMP()
            WHERE emp_id = ? AND \`system\` = 'GOOGLE' AND external_id = ?`,
          [row.emp_id, row.external_id],
        );
        await execute(
          `UPDATE employees SET ilg_state = 'SUSPENDED_AUTO', sync_status = 'DISABLED',
                  updated_at = UTC_TIMESTAMP() WHERE emp_id = ? AND ilg_state = 'ACTIVE'`,
          [row.emp_id],
        );
        disabled++;
        await writeDirectoryUserAudit({
          empId: row.emp_id,
          action: 'GOOGLE_SYNC_DISABLE',
          source: 'GOOGLE',
          detail: { reason: 'missing_from_google_directory' },
        });
      } catch (err) {
        failed++;
        errors.push(`${row.emp_id}: disable failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const repaired = await repairOrphanGoogleLinks(googleUsers, errors);
  if (repaired > 0) {
    logger.info({ repaired }, 'Google sync inbound: repaired orphan identity links');
  }

  return {
    found: googleUsers.length,
    imported,
    linked,
    updated,
    skipped,
    processed,
    succeeded,
    failed,
    disabled,
    repaired,
    notFoundEmails: scoped.notFoundEmails,
  };
}

/** Link employees that exist without a Google identity_link row. */
async function repairOrphanGoogleLinks(
  googleUsers: admin_directory_v1.Schema$User[],
  errors: string[],
): Promise<number> {
  let repaired = 0;

  for (const gUser of googleUsers) {
    const email = (gUser.primaryEmail ?? '').trim().toLowerCase();
    const googleId = gUser.id ?? email;
    if (!email || !googleId) continue;

    const hasLink = await queryOne<{ id: number }>(
      `SELECT id FROM identity_links WHERE \`system\` = 'GOOGLE' AND external_id = ? AND status != 'DELETED'`,
      [googleId],
    );
    if (hasLink) continue;

    const emp = await queryOne<{ emp_id: string }>(
      `SELECT emp_id FROM employees WHERE email_corp = ? OR emp_id = ?`,
      [email, deriveEmpIdFromGoogle(gUser)],
    );
    if (!emp) continue;

    const linkStatus = gUser.suspended === true ? 'DISABLED' : 'ACTIVE';
    try {
      await upsertGoogleIdentityLink(emp.emp_id, googleId, linkStatus);
      repaired++;
      logger.info({ empId: emp.emp_id, googleId }, 'Google sync: repaired missing identity link');
    } catch (err) {
      errors.push(`${email}: link repair failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return repaired;
}

function isGoogleNotFound(err: unknown): boolean {
  const e = err as { code?: number; response?: { status?: number } };
  return e?.code === 404 || e?.response?.status === 404;
}

/** Link a Google Workspace user by corporate email when missing (e.g. before password writeback). */
export async function backfillGoogleIdentityLinkIfMissing(
  empId: string,
  emailCorp: string,
): Promise<{ changed: boolean }> {
  if (!emailCorp.trim()) return { changed: false };

  const email = emailCorp.toLowerCase().trim();
  const hasLink = await queryOne<{ id: number }>(
    `SELECT id FROM identity_links
      WHERE emp_id = ? AND \`system\` = 'GOOGLE' AND status != 'DELETED'`,
    [empId],
  );
  if (hasLink) return { changed: false };

  const conn = await queryOne<{ config_json: string | Record<string, unknown> }>(
    `SELECT config_json FROM connectors
      WHERE connector_type IN ('GOOGLE', 'GOOGLE_WORKSPACE')
        AND status IN ('CONNECTED', 'ACTIVE')
      ORDER BY updated_at DESC LIMIT 1`,
    [],
  );
  if (!conn) return { changed: false };

  const cfg: Record<string, unknown> =
    typeof conn.config_json === 'string'
      ? JSON.parse(conn.config_json || '{}') as Record<string, unknown>
      : (conn.config_json ?? {});

  try {
    const auth = buildGoogleJwtAuth(cfg);
    const directory = google.admin({ version: 'directory_v1', auth });
    const existing = await directory.users.get({ userKey: email });
    const googleId = existing.data.id ?? email;
    const suspended = existing.data.suspended === true;
    const linkStatus = suspended ? 'DISABLED' : 'ACTIVE';
    await upsertGoogleIdentityLink(empId, googleId, linkStatus);
    logger.info({ empId, googleId, email }, 'Google identity link backfilled for password writeback');
    return { changed: true };
  } catch (err) {
    if (isGoogleNotFound(err)) {
      logger.info({ empId, email }, 'Google backfill: no Workspace user for corporate email');
      return { changed: false };
    }
    logger.warn({ empId, email, err }, 'Google identity link backfill failed');
    return { changed: false };
  }
}

// ---------------------------------------------------------------------------
// Main sync function
// ---------------------------------------------------------------------------
export async function runGoogleSync(
  connectorId: string,
  opts: { runType?: 'INCREMENTAL' | 'FULL_SYNC' } = {},
): Promise<SyncResult & {
  usersAdded?: number;
  usersUpdated?: number;
  usersDisabled?: number;
  durationMs?: number;
}> {
  const runId = uuidv4();
  // connector_runs.run_type ENUM is FULL_SYNC | INCREMENTAL | … (not "FULL")
  const runType = opts.runType === 'FULL_SYNC' ? 'FULL_SYNC' : 'INCREMENTAL';
  const startedAt = Date.now();

  await execute(
    `INSERT INTO connector_runs
       (id, connector_id, run_type, status, started_at, items_processed, items_succeeded, items_failed)
     VALUES (?, ?, ?, 'RUNNING', UTC_TIMESTAMP(), 0, 0, 0)`,
    [runId, connectorId, runType],
  );

  const connRow = await queryOne<{ direction: string; config_json: string | Record<string, unknown> }>(
    `SELECT direction, config_json FROM connectors WHERE id = ?`,
    [connectorId],
  );
  if (!connRow) {
    throw new Error(`Connector not found: ${connectorId}`);
  }

  const cfg: Record<string, unknown> =
    typeof connRow.config_json === 'string'
      ? JSON.parse(connRow.config_json || '{}') as Record<string, unknown>
      : (connRow.config_json ?? {});

  const scope = resolveGoogleSyncScope(cfg);
  const direction = (connRow.direction ?? 'BIDIRECTIONAL').toUpperCase();
  const runInbound  = direction === 'INBOUND' || direction === 'BIDIRECTIONAL';
  const runOutbound = direction === 'OUTBOUND' || direction === 'BIDIRECTIONAL';

  const auth = buildGoogleJwtAuth(cfg);
  const directory = google.admin({ version: 'directory_v1', auth });

  let itemsProcessed = 0;
  let itemsSucceeded = 0;
  let itemsFailed = 0;
  let usersAdded = 0;
  let usersUpdated = 0;
  let usersDisabled = 0;
  const errors: string[] = [];
  let inboundSummary = '';

  try {
    if (runInbound) {
      const inbound = await importGoogleDirectoryUsers(directory, scope, errors, { runType });
      itemsProcessed += inbound.processed;
      itemsSucceeded += inbound.succeeded;
      itemsFailed += inbound.failed;
      usersAdded = inbound.imported;
      usersUpdated = inbound.updated;
      usersDisabled = inbound.disabled;
      let groupSummary = '';
      try {
        const gs = await syncGoogleDirectoryGroups(connectorId, directory, scope, cfg);
        const mode = gs.autoAll ? ' (auto-all)' : '';
        groupSummary =
          ` | Groups: ${gs.groupsSynced} synced, ${gs.membersSynced} members` +
          mode +
          (gs.errors.length
            ? ` (${gs.errors.length} errors: ${gs.errors.slice(0, 2).join('; ')}${gs.errors.length > 2 ? '…' : ''})`
            : gs.groupsSynced === 0
              ? ' (none matched — add group emails in Sync Groups, or use * / blank for auto-all)'
              : '');
        errors.push(...gs.errors);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        groupSummary = ` | Groups: failed (${msg})`;
        errors.push(`Google group sync: ${msg}`);
      }

      const notFoundHint = inbound.notFoundEmails.length
        ? `, ${inbound.notFoundEmails.length} not in Google (${inbound.notFoundEmails.slice(0, 3).join(', ')}${inbound.notFoundEmails.length > 3 ? '…' : ''})`
        : '';

      inboundSummary =
        `Inbound: ${inbound.found} Google users found, ${inbound.imported} added, ${inbound.updated} updated, ${inbound.linked} linked` +
        (inbound.disabled ? `, ${inbound.disabled} disabled` : '') +
        (inbound.repaired ? `, ${inbound.repaired} links repaired` : '') +
        `, ${inbound.skipped} skipped` +
        notFoundHint +
        groupSummary +
        (runOutbound ? ' | Outbound: see employee reconcile below' : '');
      logger.info({ connectorId, runId, inbound }, 'Google sync inbound phase complete');
    }

    if (!runOutbound) {
      logger.info({ connectorId, direction }, 'Google sync: OUTBOUND skipped');
    } else {
      const employees = await query<EmployeeRow>(
        `SELECT emp_id, full_name, email_corp, ilg_state
           FROM employees
          ORDER BY emp_id`,
        [],
      );

      logger.info({ connectorId, runId, count: employees.length }, 'Google sync outbound: processing employees');

      let outboundSkipped = 0;

      for (const emp of employees) {
        const link = await queryOne<IdentityLinkRow>(
          `SELECT id, external_id, status
             FROM identity_links
            WHERE emp_id = ? AND \`system\` = 'GOOGLE' AND status NOT IN ('DELETED')`,
          [emp.emp_id],
        );

        if (!employeeEligibleForGoogleOutbound(emp.email_corp, scope, !!link)) {
          outboundSkipped++;
          continue;
        }

        itemsProcessed++;

        try {
          const isActive   = emp.ilg_state === 'ACTIVE' || emp.ilg_state === 'REACTIVATED';
          const isInactive = emp.ilg_state === 'SUSPENDED_HR'
                          || emp.ilg_state === 'SUSPENDED_AUTO'
                          || emp.ilg_state === 'DEPARTED'
                          || emp.ilg_state === 'DEPROVISIONED';

          if (isActive && !link) {
            // Reconcile: link existing Google account by email before provisioning
            try {
              const existing = await directory.users.get({ userKey: emp.email_corp });
              const googleId = existing.data.id ?? emp.email_corp;
              await upsertGoogleIdentityLink(emp.emp_id, googleId, 'ACTIVE');
              logger.info({ empId: emp.emp_id, googleId }, 'Google sync: existing user reconciled and linked');
              itemsSucceeded++;
            } catch (lookupErr) {
              if (!isGoogleNotFound(lookupErr)) throw lookupErr;

              const { givenName, familyName } = parseNameParts(emp.full_name);
              const tempPass = generateTempPassword();

              const res = await directory.users.insert({
                requestBody: {
                  primaryEmail: emp.email_corp,
                  name: { givenName, familyName },
                  password: tempPass,
                  changePasswordAtNextLogin: true,
                  orgUnitPath: scope.provisionOrgUnit,
                },
              });

              const googleId = res.data.id ?? emp.email_corp;
              await upsertGoogleIdentityLink(emp.emp_id, googleId, 'ACTIVE');
              logger.info({ empId: emp.emp_id, googleId }, 'Google sync: user provisioned');
              itemsSucceeded++;
            }
          } else if (isInactive && link && link.status === 'ACTIVE') {
            await directory.users.update({
              userKey:     link.external_id,
              requestBody: { suspended: true },
            });

            await execute(
              `UPDATE identity_links SET status = 'DISABLED', last_synced_at = UTC_TIMESTAMP() WHERE id = ?`,
              [link.id],
            );

            logger.info({ empId: emp.emp_id, externalId: link.external_id }, 'Google sync: user suspended');
            itemsSucceeded++;
          } else if (isActive && link && link.status === 'DISABLED') {
            await directory.users.update({
              userKey:     link.external_id,
              requestBody: { suspended: false },
            });

            await execute(
              `UPDATE identity_links SET status = 'ACTIVE', last_synced_at = UTC_TIMESTAMP() WHERE id = ?`,
              [link.id],
            );

            logger.info({ empId: emp.emp_id, externalId: link.external_id }, 'Google sync: user re-enabled');
            itemsSucceeded++;
          } else {
            itemsSucceeded++;
          }
        } catch (err) {
          itemsFailed++;
          const msg = `${emp.emp_id}: ${err instanceof Error ? err.message : String(err)}`;
          errors.push(msg);
          logger.error({ empId: emp.emp_id, err }, 'Google sync outbound: per-employee error (non-fatal)');
        }
      }

      if (outboundSkipped > 0) {
        logger.info({ connectorId, runId, outboundSkipped }, 'Google sync outbound: skipped employees outside sync scope');
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
  const errorSummary = [
    inboundSummary,
    errors.length > 0 ? errors.slice(0, 10).join('; ') : '',
  ].filter(Boolean).join(' — ') || null;

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
    { connectorId, runId, itemsProcessed, itemsSucceeded, itemsFailed, finalStatus, direction, usersAdded, usersUpdated, usersDisabled },
    'Google sync completed',
  );

  return {
    runId,
    connectorId,
    itemsProcessed,
    itemsSucceeded,
    itemsFailed,
    errors,
    usersAdded,
    usersUpdated,
    usersDisabled,
    durationMs: Date.now() - startedAt,
  };
}

/** Full directory resync — same pipeline with FULL_SYNC run type + optional disable-deleted. */
export async function runGoogleFullSync(connectorId: string) {
  return runGoogleSync(connectorId, { runType: 'FULL_SYNC' });
}
