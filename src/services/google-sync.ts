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
import { applyDirectorySourceDisabled, applyDirectorySourceEnabled, preserveIlgStateOnDirectoryImport } from './user-lifecycle.js';
import { ILGState } from '../fsm/states.js';
import { v4 as uuidv4 } from 'uuid';
import {
  buildGoogleJwtAuth,
  employeeEligibleForGoogleOutbound,
  listScopedGoogleUsers,
  lookupGoogleDirectoryIdentity,
  normalizeConnectorDirection,
  resolveGoogleSyncScope,
  type ConnectorSyncDirection,
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
import { failConnectorRunIfActive, updateConnectorRunProgress } from './connector-run-lifecycle.js';
import type { ConnectorRunUserResult } from './connector-run-export.js';

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

function recordGoogleInboundUser(
  userResults: ConnectorRunUserResult[],
  email: string,
  fullName: string,
  attrs: ExtractedAttrs,
  empId: string | undefined,
  action: string,
  status: 'OK' | 'FAILED' = 'OK',
  error?: string,
): void {
  const row: ConnectorRunUserResult = { email, status, action };
  if (fullName) row.fullName = fullName;
  if (empId) row.empId = empId;
  if (attrs.employee_number) row.employeeNumber = attrs.employee_number;
  if (attrs.dept_id) row.department = attrs.dept_id;
  if (error) row.error = error;
  userResults.push(row);
}

/** Import Google Workspace users into employees + identity_links (merge by email). */
async function importGoogleDirectoryUsers(
  directory: admin_directory_v1.Admin,
  scope: GoogleSyncScope,
  errors: string[],
  opts: {
    runType?: 'INCREMENTAL' | 'FULL_SYNC';
    disableDeleted?: boolean;
    onUserResults?: (
      results: ConnectorRunUserResult[],
      partial: boolean,
      counts: { processed: number; succeeded: number; failed: number },
    ) => void | Promise<void>;
    onProgress?: (p: {
      processed: number;
      succeeded: number;
      failed: number;
      total: number;
    }) => void | Promise<void>;
  } = {},
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
  userResults: ConnectorRunUserResult[];
}> {
  const scoped = await listScopedGoogleUsers(directory, scope);
  const googleUsers = scoped.users;
  const total = googleUsers.length;
  if (opts.onProgress) {
    await opts.onProgress({ processed: 0, succeeded: 0, failed: 0, total });
  }
  for (const email of scoped.notFoundEmails) {
    errors.push(`Google user not found: ${email}`);
  }
  const userResults: ConnectorRunUserResult[] = scoped.notFoundEmails.map((email) => ({
    email: email.trim().toLowerCase(),
    status: 'FAILED',
    action: 'not_found',
    error: 'User not found in Google Workspace',
  }));
  if (opts.onUserResults && userResults.length) {
    await opts.onUserResults(userResults, true, { processed: 0, succeeded: 0, failed: userResults.length });
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
            `UPDATE employees SET full_name = ?, sync_status = 'DISABLED', updated_at = UTC_TIMESTAMP() WHERE emp_id = ?`,
            [fullName, targetEmpId],
          );
          await applyAttrsToEmployee(targetEmpId, attrs, { syncSettings });
          await applyDirectorySourceDisabled(targetEmpId, 'GOOGLE', 'google_account_suspended');
          linked++;
          disabled++;
          recordGoogleInboundUser(userResults, email, fullName, attrs, targetEmpId, 'disabled');
        }
        skipped++;
        succeeded++;
        continue;
      }

      if (existingLink?.emp_id) {
        const currentState = (await queryOne<{ ilg_state: string }>(
          `SELECT ilg_state FROM employees WHERE emp_id = ?`,
          [existingLink.emp_id],
        ))?.ilg_state;

        if (currentState === ILGState.SUSPENDED_AUTO) {
          await applyDirectorySourceEnabled(existingLink.emp_id, 'GOOGLE');
        }

        const ilgState = currentState
          ? preserveIlgStateOnDirectoryImport(currentState)
          : ILGState.ACTIVE;

        await upsertGoogleIdentityLink(existingLink.emp_id, googleId, 'ACTIVE');
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
        recordGoogleInboundUser(
          userResults,
          email,
          fullName,
          attrs,
          existingLink.emp_id,
          applied.updated ? 'updated' : 'linked',
        );
        continue;
      }

      const ilgState = ILGState.ACTIVE;

      let empId = preferEmpId(gUser, attrs);
      let userAction = 'linked';
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
        if (applied.updated) { updated++; userAction = 'updated'; }
        linked++;
      } else if (byEmpNumber) {
        empId = byEmpNumber.emp_id;
        await execute(
          `UPDATE employees SET email_corp = ?, ilg_state = ?, updated_at = UTC_TIMESTAMP() WHERE emp_id = ?`,
          [email, ilgState, empId],
        );
        const applied = await applyAttrsToEmployee(empId, attrs, { syncSettings });
        if (applied.updated) { updated++; userAction = 'updated'; }
        linked++;
      } else if (byEmpId) {
        await execute(
          `UPDATE employees SET email_corp = ?, ilg_state = ?, updated_at = UTC_TIMESTAMP() WHERE emp_id = ?`,
          [email, ilgState, empId],
        );
        const applied = await applyAttrsToEmployee(empId, attrs, { syncSettings });
        if (applied.updated) { updated++; userAction = 'updated'; }
        linked++;
      } else {
        await insertEmployeeFromGoogleAttrs(empId, email, ilgState, attrs);
        if (attrs.manager_email) {
          await applyAttrsToEmployee(empId, attrs, { syncSettings });
        }
        imported++;
        userAction = 'imported';
        await writeDirectoryUserAudit({
          empId,
          action: 'GOOGLE_SYNC_CREATE',
          source: 'GOOGLE',
          newValues: { email, ...attrs },
        });
      }

      await upsertGoogleIdentityLink(empId, googleId, 'ACTIVE');
      succeeded++;
      recordGoogleInboundUser(userResults, email, fullName, attrs, empId, userAction);
    } catch (err) {
      failed++;
      const msg = `${email || googleId}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      if (email) {
        recordGoogleInboundUser(
          userResults,
          email,
          email.split('@')[0] || email,
          { full_name: email.split('@')[0] || email } as ExtractedAttrs,
          undefined,
          'failed',
          'FAILED',
          err instanceof Error ? err.message : String(err),
        );
      }
      logger.error({ email, googleId, err }, 'Google sync inbound: user import failed');
    }
    if (opts.onUserResults && (processed === 1 || processed % 500 === 0)) {
      await opts.onUserResults(userResults, true, { processed, succeeded, failed });
    }
    if (opts.onProgress && (
      processed === 1
      || processed % 250 === 0
      || processed === total
    )) {
      await opts.onProgress({ processed, succeeded, failed, total });
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
          `UPDATE employees SET sync_status = 'DISABLED', updated_at = UTC_TIMESTAMP()
             WHERE emp_id = ?`,
          [row.emp_id],
        );
        await applyDirectorySourceDisabled(row.emp_id, 'GOOGLE', 'missing_from_google_directory');
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

  if (opts.onUserResults) {
    await opts.onUserResults(userResults, false, { processed, succeeded, failed });
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
    userResults,
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

  const conn = await queryOne<{ config_json: string | Record<string, unknown>; direction: string }>(
    `SELECT config_json, direction FROM connectors
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
    const auth = buildGoogleJwtAuth(cfg, normalizeConnectorDirection(conn.direction));
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

  let itemsProcessed = 0;
  let itemsSucceeded = 0;
  let itemsFailed = 0;
  let usersAdded = 0;
  let usersUpdated = 0;
  let usersDisabled = 0;
  const errors: string[] = [];
  let inboundSummary = '';
  let direction = 'BIDIRECTIONAL';
  let userResults: ConnectorRunUserResult[] = [];

  const reportProgress = async (phase: string, detail?: string) => {
    await updateConnectorRunProgress(runId, {
      phase,
      itemsProcessed,
      itemsSucceeded,
      itemsFailed,
      ...(detail !== undefined ? { detail } : {}),
      ...(userResults.length ? { userResults, partial: true } : {}),
    });
  };

  try {
  await reportProgress('starting', 'Loading connector configuration');

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
  direction = (connRow.direction ?? 'BIDIRECTIONAL').toUpperCase();
  const syncDirection = normalizeConnectorDirection(direction);
  const runInbound  = direction === 'INBOUND' || direction === 'BIDIRECTIONAL';
  const runOutbound = direction === 'OUTBOUND' || direction === 'BIDIRECTIONAL';

  const auth = buildGoogleJwtAuth(cfg, syncDirection);
  const directory = google.admin({ version: 'directory_v1', auth });

    if (runInbound) {
      await reportProgress('listing', 'Fetching users from Google Workspace');
      const inbound = await importGoogleDirectoryUsers(directory, scope, errors, {
        runType,
        onProgress: async (p) => {
          itemsProcessed = p.processed;
          itemsSucceeded = p.succeeded;
          itemsFailed = p.failed;
          const nearEnd = p.total > 0 && p.total - p.processed <= 100;
          if (p.processed === 0 || p.processed % 250 === 0 || p.processed === p.total || nearEnd) {
            await reportProgress('inbound', `${p.processed} / ${p.total} Google users`);
          }
        },
        onUserResults: async (results, partial, counts) => {
          userResults = results;
          itemsProcessed = counts.processed;
          itemsSucceeded = counts.succeeded;
          itemsFailed = counts.failed;
          await updateConnectorRunProgress(runId, {
            phase: partial ? 'inbound' : 'inbound-complete',
            itemsProcessed,
            itemsSucceeded,
            itemsFailed,
            userResults,
            partial,
          });
        },
      });
      itemsProcessed = inbound.processed;
      itemsSucceeded = inbound.succeeded;
      itemsFailed = inbound.failed;
      userResults = inbound.userResults;
      usersAdded = inbound.imported;
      usersUpdated = inbound.updated;
      usersDisabled = inbound.disabled;
      let groupSummary = '';
      try {
        await reportProgress('groups', 'Syncing Google groups and memberships');
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
    await failConnectorRunIfActive(runId, fatalErr, { itemsProcessed, itemsSucceeded, itemsFailed });
    throw fatalErr;
  }

  const finalStatus = itemsFailed > 0 ? 'PARTIAL' : 'SUCCESS';
  const errorSummary = [
    inboundSummary,
    errors.length > 0 ? errors.slice(0, 10).join('; ') : '',
  ].filter(Boolean).join(' — ') || null;

  const finalPayload = JSON.stringify({
    userResults,
    partial: false,
    phase: 'complete',
    progressAt: new Date().toISOString(),
  });

  await execute(
    `UPDATE connector_runs
        SET status = ?, ended_at = UTC_TIMESTAMP(),
            items_processed = ?, items_succeeded = ?, items_failed = ?,
            error_summary = ?, payload = ?
      WHERE id = ?`,
    [finalStatus, itemsProcessed, itemsSucceeded, itemsFailed, errorSummary, finalPayload, runId],
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

export interface GoogleUserSyncDiagnostic {
  ok: boolean;
  kind: 'user' | 'group' | 'not_found';
  lookupEmail: string;
  primaryEmail?: string;
  empId?: string;
  imported?: boolean;
  updated?: boolean;
  linked?: boolean;
  message: string;
  local?: {
    empId: string;
    emailCorp: string;
    employeeNumber: string | null;
    deptId: string | null;
    ilgState: string;
    syncStatus: string | null;
    googleLinkStatus: string | null;
  } | null;
  google?: {
    suspended?: boolean;
    orgUnitPath?: string;
    aliases?: string[];
  };
}

async function loadGoogleConnectorContext(connectorId: string): Promise<{
  cfg: Record<string, unknown>;
  direction: ConnectorSyncDirection;
}> {
  const connRow = await queryOne<{ config_json: string | Record<string, unknown>; direction: string }>(
    `SELECT config_json, direction FROM connectors WHERE id = ?`,
    [connectorId],
  );
  if (!connRow) throw new Error(`Connector not found: ${connectorId}`);
  const cfg = typeof connRow.config_json === 'string'
    ? JSON.parse(connRow.config_json || '{}') as Record<string, unknown>
    : (connRow.config_json ?? {});
  return { cfg, direction: normalizeConnectorDirection(connRow.direction) };
}

/** Diagnose and optionally import a single Google user by email or alias (bypasses sync scope). */
export async function syncGoogleUserByEmail(
  connectorId: string,
  email: string,
  opts: { importUser?: boolean } = {},
): Promise<GoogleUserSyncDiagnostic> {
  const lookupEmail = email.trim().toLowerCase();
  const importUser = opts.importUser !== false;
  const { cfg, direction } = await loadGoogleConnectorContext(connectorId);
  const auth = buildGoogleJwtAuth(cfg, direction);
  const directory = google.admin({ version: 'directory_v1', auth });

  const local = await queryOne<{
    emp_id: string;
    email_corp: string;
    employee_number: string | null;
    dept_id: string | null;
    ilg_state: string;
    sync_status: string | null;
    google_link_status: string | null;
  }>(
    `SELECT e.emp_id, e.email_corp, e.employee_number, e.dept_id, e.ilg_state, e.sync_status,
            il.status AS google_link_status
       FROM employees e
       LEFT JOIN identity_links il ON il.emp_id = e.emp_id AND il.\`system\` = 'GOOGLE' AND il.status != 'DELETED'
      WHERE e.email_corp = ?
      LIMIT 1`,
    [lookupEmail],
  );

  const identity = await lookupGoogleDirectoryIdentity(directory, lookupEmail);

  if (identity.kind === 'group') {
    return {
      ok: false,
      kind: 'group',
      lookupEmail,
      message: `${lookupEmail} is a Google Group${identity.name ? ` (“${identity.name}”)` : ''}, not a user account. Groups sync to IdP Groups — they do not appear as Universal Directory users.`,
      local: local
        ? {
          empId: local.emp_id,
          emailCorp: local.email_corp,
          employeeNumber: local.employee_number,
          deptId: local.dept_id,
          ilgState: local.ilg_state,
          syncStatus: local.sync_status,
          googleLinkStatus: local.google_link_status,
        }
        : null,
    };
  }

  if (identity.kind === 'not_found') {
    return {
      ok: false,
      kind: 'not_found',
      lookupEmail,
      message: `No Google Workspace user or group found for ${lookupEmail}. Verify the address in Google Admin or add it to Sync Users and re-run sync.`,
      local: local
        ? {
          empId: local.emp_id,
          emailCorp: local.email_corp,
          employeeNumber: local.employee_number,
          deptId: local.dept_id,
          ilgState: local.ilg_state,
          syncStatus: local.sync_status,
          googleLinkStatus: local.google_link_status,
        }
        : null,
    };
  }

  const gUser = identity.user;
  const primaryEmail = (gUser.primaryEmail ?? '').trim().toLowerCase();
  const aliases = (gUser.aliases ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean);
  const googleMeta: GoogleUserSyncDiagnostic['google'] = {
    suspended: gUser.suspended === true,
    aliases,
  };
  if (gUser.orgUnitPath) googleMeta.orgUnitPath = gUser.orgUnitPath;

  if (!importUser) {
    const localByPrimary = primaryEmail !== lookupEmail
      ? await queryOne<{ emp_id: string; email_corp: string; employee_number: string | null; dept_id: string | null; ilg_state: string; sync_status: string | null; google_link_status: string | null }>(
        `SELECT e.emp_id, e.email_corp, e.employee_number, e.dept_id, e.ilg_state, e.sync_status,
                il.status AS google_link_status
           FROM employees e
           LEFT JOIN identity_links il ON il.emp_id = e.emp_id AND il.\`system\` = 'GOOGLE' AND il.status != 'DELETED'
          WHERE e.email_corp = ?
          LIMIT 1`,
        [primaryEmail],
      )
      : local;

    return {
      ok: true,
      kind: 'user',
      lookupEmail,
      primaryEmail,
      ...(localByPrimary?.emp_id ? { empId: localByPrimary.emp_id } : {}),
      message: primaryEmail !== lookupEmail
        ? `Google user found. Primary email is ${primaryEmail} (you looked up alias ${lookupEmail}).`
        : `Google user found for ${primaryEmail}.`,
      local: localByPrimary
        ? {
          empId: localByPrimary.emp_id,
          emailCorp: localByPrimary.email_corp,
          employeeNumber: localByPrimary.employee_number,
          deptId: localByPrimary.dept_id,
          ilgState: localByPrimary.ilg_state,
          syncStatus: localByPrimary.sync_status,
          googleLinkStatus: localByPrimary.google_link_status,
        }
        : null,
      google: googleMeta,
    };
  }

  const attrMaps = await listGoogleAttrMaps();
  const syncSettings = await getGoogleSyncSettings();
  const seenGoogleIds = new Set<string>();
  const result = await importOneGoogleUser(gUser, { attrMaps, syncSettings, seenGoogleIds });

  const empRow = await queryOne<{ emp_id: string }>(
    `SELECT emp_id FROM employees WHERE email_corp = ? LIMIT 1`,
    [primaryEmail],
  );
  if (empRow) {
    const attrs = await extractGoogleAttrs(gUser, attrMaps, syncSettings);
    await applyAttrsToEmployee(empRow.emp_id, attrs, {
      syncSettings,
      resolveManager: true,
      googleSourceOfTruth: true,
    });
  }

  const after = await queryOne<{
    emp_id: string;
    email_corp: string;
    employee_number: string | null;
    dept_id: string | null;
    ilg_state: string;
    sync_status: string | null;
    google_link_status: string | null;
  }>(
    `SELECT e.emp_id, e.email_corp, e.employee_number, e.dept_id, e.ilg_state, e.sync_status,
            il.status AS google_link_status
       FROM employees e
       LEFT JOIN identity_links il ON il.emp_id = e.emp_id AND il.\`system\` = 'GOOGLE' AND il.status != 'DELETED'
      WHERE e.email_corp = ?
      LIMIT 1`,
    [primaryEmail],
  );

  const aliasNote = primaryEmail !== lookupEmail
    ? ` Primary email in Google is ${primaryEmail} — search Universal Directory using that address.`
    : '';

  return {
    ok: true,
    kind: 'user',
    lookupEmail,
    primaryEmail,
    ...(after?.emp_id ? { empId: after.emp_id } : {}),
    imported: result.imported > 0,
    updated: result.updated > 0,
    linked: result.linked > 0,
    message: `Synced Google user ${primaryEmail}.${aliasNote}`,
    local: after
      ? {
        empId: after.emp_id,
        emailCorp: after.email_corp,
        employeeNumber: after.employee_number,
        deptId: after.dept_id,
        ilgState: after.ilg_state,
        syncStatus: after.sync_status,
        googleLinkStatus: after.google_link_status,
      }
      : null,
    google: googleMeta,
  };
}

