/**
 * AD Sync Service
 * ---------------
 * Reconciliation between the IDP employee database and Active Directory.
 *
 * INBOUND  — import AD users under the search base into employees + identity_links
 * OUTBOUND — provision / disable / re-enable AD accounts for IdP employees
 * BIDIRECTIONAL — both phases (default connector direction)
 */

import crypto from 'crypto';
import { ADAdapter, resolveAdDirectoryConfig, getLdapAttr, readAdEmployeeId, cleanAdDisplayName, readAdObjectGuid, type AdDirectoryConfig } from '../adapters/ad-adapter.js';
import { parseCsvList } from './google-directory-config.js';
import { resolveAdSyncScope, employeeEligibleForAdProvision, resolveAdCorporateEmail, resolveAdDefaultEmailDomain, parseAdUpnDomains, resolveUpnSuffixForProvision, isImportableAdDirectoryUser, resolveAdSearchBases, resolveAdLdapScope } from './ad-directory-config.js';
import type { GroupSyncSummary } from './group-sync.js';
import { query, queryOne, execute, transaction } from '../db/connection.js';
import { config } from '../config.js';
import { redis } from '../auth/session-store.js';
import logger from '../utils/logger.js';
import { parseConnectorBoolean, parseConnectorPort } from '../utils/connector-config.js';
import { applyDirectorySourceDisabled, applyDirectorySourceEnabled, preserveIlgStateOnDirectoryImport } from './user-lifecycle.js';
import { ILGState } from '../fsm/states.js';
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

function formatAdGroupSyncSummary(cfg: Record<string, unknown>, gs: GroupSyncSummary): string {
  const keys = parseCsvList(cfg['syncGroups']);
  const mode = keys.length ? '' : ' (auto-all)';
  let line = ` | Groups: ${gs.groupsSynced} synced, ${gs.membersSynced} members`;
  line += mode;
  if (gs.errors.length) {
    const preview = gs.errors.slice(0, 2).join('; ');
    line += ` (${gs.errors.length} errors: ${preview}${gs.errors.length > 2 ? '…' : ''})`;
  } else if (gs.groupsSynced === 0) {
    line += ' (none matched — verify group names or use * for all security groups)';
  }
  return line;
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

function deriveEmpIdHashFromSam(adUser: Record<string, unknown>): string {
  const sam = getLdapAttr(adUser, 'sAMAccountName') || 'user';
  const hash = crypto.createHash('md5').update(sam).digest('hex').slice(0, 12).toUpperCase();
  return `AD-${hash}`;
}

function isDuplicateKeyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code;
  return code === 'ER_DUP_ENTRY' || /duplicate entry/i.test(err.message);
}

function readAdNameParts(
  adUser: Record<string, unknown>,
  fullName: string,
  sam: string,
): { firstName: string | null; lastName: string | null } {
  const given = getLdapAttr(adUser, 'givenName').trim();
  const sn = getLdapAttr(adUser, 'sn').trim();
  if (given || sn) {
    return {
      firstName: given.slice(0, 100) || null,
      lastName: sn.slice(0, 100) || null,
    };
  }
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: sam.slice(0, 100), lastName: null };
  if (parts.length === 1) return { firstName: parts[0].slice(0, 100), lastName: null };
  return {
    firstName: parts[0].slice(0, 100),
    lastName: parts.slice(1).join(' ').slice(0, 100),
  };
}

/**
 * Rename an employees row's primary key, cascading to every child table that
 * has a FK to employees(emp_id). Used when an AD-XXXX placeholder emp_id is
 * being replaced with the real employeeID returned by Active Directory.
 *
 * Why: none of the FK constraints declare ON UPDATE CASCADE, so a plain
 * UPDATE on the PK would fail. We discover the referencing columns from
 * information_schema and update each within a single transaction.
 */
async function migrateEmpId(oldId: string, newId: string): Promise<void> {
  if (oldId === newId) return;
  await transaction(async (conn) => {
    const fkCols = await query<{ TABLE_NAME: string; COLUMN_NAME: string }>(
      `SELECT TABLE_NAME, COLUMN_NAME
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE REFERENCED_TABLE_SCHEMA = DATABASE()
          AND REFERENCED_TABLE_NAME   = 'employees'
          AND REFERENCED_COLUMN_NAME  = 'emp_id'`,
      [],
      conn,
    );

    await execute(`SET FOREIGN_KEY_CHECKS = 0`, [], conn);
    try {
      for (const { TABLE_NAME, COLUMN_NAME } of fkCols) {
        await execute(
          `UPDATE \`${TABLE_NAME}\` SET \`${COLUMN_NAME}\` = ? WHERE \`${COLUMN_NAME}\` = ?`,
          [newId, oldId],
          conn,
        );
      }
      await execute(`UPDATE employees SET emp_id = ? WHERE emp_id = ?`, [newId, oldId], conn);
      // adapter_outbox holds emp_id but has no FK
      await execute(`UPDATE adapter_outbox SET emp_id = ? WHERE emp_id = ?`, [newId, oldId], conn);
    } finally {
      await execute(`SET FOREIGN_KEY_CHECKS = 1`, [], conn);
    }
  });
}

type MigrateEmpIdOutcome = 'migrated' | 'merged' | 'skipped' | 'noop';

/** Drop a placeholder row when the canonical emp_id row already exists for the same email. */
async function absorbPlaceholderEmployee(oldId: string, newId: string): Promise<void> {
  await transaction(async (conn) => {
    const links = await query<{ external_id: string; status: string }>(
      `SELECT external_id, status FROM identity_links
        WHERE emp_id = ? AND \`system\` = 'AD' AND status != 'DELETED'`,
      [oldId],
      conn,
    );
    for (const link of links) {
      await execute(
        `INSERT INTO identity_links (emp_id, \`system\`, external_id, status, auth_kind, last_synced_at)
         VALUES (?, 'AD', ?, ?, 'LDAP', UTC_TIMESTAMP())
         ON DUPLICATE KEY UPDATE
           emp_id = VALUES(emp_id),
           status = VALUES(status),
           last_synced_at = UTC_TIMESTAMP()`,
        [newId, link.external_id, link.status],
        conn,
      );
    }

    const fkCols = await query<{ TABLE_NAME: string; COLUMN_NAME: string }>(
      `SELECT TABLE_NAME, COLUMN_NAME
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE REFERENCED_TABLE_SCHEMA = DATABASE()
          AND REFERENCED_TABLE_NAME   = 'employees'
          AND REFERENCED_COLUMN_NAME  = 'emp_id'`,
      [],
      conn,
    );

    await execute(`SET FOREIGN_KEY_CHECKS = 0`, [], conn);
    try {
      for (const { TABLE_NAME, COLUMN_NAME } of fkCols) {
        if (TABLE_NAME === 'employees') continue;
        await execute(
          `UPDATE \`${TABLE_NAME}\` SET \`${COLUMN_NAME}\` = ? WHERE \`${COLUMN_NAME}\` = ?`,
          [newId, oldId],
          conn,
        );
      }
      await execute(`UPDATE adapter_outbox SET emp_id = ? WHERE emp_id = ?`, [newId, oldId], conn);
      await execute(`DELETE FROM employees WHERE emp_id = ?`, [oldId], conn);
    } finally {
      await execute(`SET FOREIGN_KEY_CHECKS = 1`, [], conn);
    }
  });
}

/**
 * Migrate AD-XXXX → real employeeID when safe. Skips when the target emp_id belongs
 * to a different person; merges duplicate rows when email matches.
 */
async function tryMigrateEmpId(
  oldId: string,
  newId: string,
  contextEmail?: string,
): Promise<MigrateEmpIdOutcome> {
  if (oldId === newId) return 'noop';

  const target = await queryOne<{ emp_id: string; email_corp: string | null }>(
    `SELECT emp_id, email_corp FROM employees WHERE emp_id = ?`,
    [newId],
  );
  if (!target) {
    await migrateEmpId(oldId, newId);
    return 'migrated';
  }

  const source = await queryOne<{ email_corp: string | null }>(
    `SELECT email_corp FROM employees WHERE emp_id = ?`,
    [oldId],
  );
  if (!source) return 'noop';

  const srcEmail = (contextEmail ?? source.email_corp ?? '').trim().toLowerCase();
  const tgtEmail = (target.email_corp ?? '').trim().toLowerCase();
  if (srcEmail && tgtEmail && srcEmail === tgtEmail) {
    await absorbPlaceholderEmployee(oldId, newId);
    return 'merged';
  }

  logger.warn(
    { from: oldId, to: newId, srcEmail: source.email_corp, tgtEmail: target.email_corp },
    'AD sync: skipped emp_id migration — target emp_id already assigned to another employee',
  );
  return 'skipped';
}

function isTrustedPrimaryEmpId(adEmpId: string): boolean {
  return /^LSP\d{4,8}$/i.test(adEmpId.trim());
}

/**
 * Resolve the IdP emp_id for an AD user. Order of preference:
 *   1. existing AD identity link for this sAMAccountName (stable across re-sync)
 *   2. corporate email match when it would not collapse another AD account
 *   3. AD employeeID when trusted (LSP#####) and not owned by another sAMAccountName
 *   4. AD-<hash> from sAMAccountName — one directory row per AD account
 */
async function resolveEmpIdForAdUser(
  adUser: Record<string, unknown>,
  email: string,
  errors: string[],
): Promise<string | null> {
  const sam = getLdapAttr(adUser, 'sAMAccountName').trim();
  const adEmpId = readAdEmployeeId(adUser);
  const emailNorm = email.trim().toLowerCase();

  if (sam) {
    const bySamLink = await queryOne<{ emp_id: string }>(
      `SELECT emp_id FROM identity_links
        WHERE \`system\` = 'AD' AND external_id = ? AND status != 'DELETED'`,
      [sam],
    );
    if (bySamLink) return bySamLink.emp_id;
  }

  if (emailNorm && !emailNorm.endsWith('@ad-sync.local')) {
    const byEmail = await queryOne<{ emp_id: string }>(
      `SELECT emp_id FROM employees WHERE LOWER(TRIM(email_corp)) = ?`,
      [emailNorm],
    );
    if (byEmail) {
      if (sam) {
        const adLinkOnRow = await queryOne<{ external_id: string }>(
          `SELECT external_id FROM identity_links
            WHERE emp_id = ? AND \`system\` = 'AD' AND status != 'DELETED'`,
          [byEmail.emp_id],
        );
        if (adLinkOnRow && adLinkOnRow.external_id.toLowerCase() !== sam.toLowerCase()) {
          return deriveEmpIdHashFromSam(adUser);
        }
      }
      if (adEmpId && byEmail.emp_id.startsWith('AD-') && byEmail.emp_id !== adEmpId && isTrustedPrimaryEmpId(adEmpId)) {
        try {
          const outcome = await tryMigrateEmpId(byEmail.emp_id, adEmpId, emailNorm);
          if (outcome === 'migrated' || outcome === 'merged') {
            logger.info(
              { from: byEmail.emp_id, to: adEmpId, email: emailNorm, outcome },
              'AD sync: migrated placeholder emp_id to AD employeeID',
            );
            return adEmpId;
          }
          if (outcome === 'skipped') return byEmail.emp_id;
        } catch (err) {
          errors.push(
            `${byEmail.emp_id} -> ${adEmpId}: emp_id migration failed — ${err instanceof Error ? err.message : String(err)}`,
          );
          return byEmail.emp_id;
        }
      }
      return byEmail.emp_id;
    }
  }

  if (adEmpId && isTrustedPrimaryEmpId(adEmpId)) {
    const byAdId = await queryOne<{ emp_id: string; email_corp: string }>(
      `SELECT emp_id, email_corp FROM employees WHERE emp_id = ?`,
      [adEmpId],
    );
    if (byAdId) {
      const existingLink = sam
        ? await queryOne<{ external_id: string }>(
          `SELECT external_id FROM identity_links
            WHERE emp_id = ? AND \`system\` = 'AD' AND status != 'DELETED'`,
          [adEmpId],
        )
        : null;
      if (existingLink && existingLink.external_id.toLowerCase() !== sam.toLowerCase()) {
        return deriveEmpIdHashFromSam(adUser);
      }
      return adEmpId;
    }
    return adEmpId;
  }

  if (adEmpId) {
    const byAdId = await queryOne<{ emp_id: string }>(
      `SELECT emp_id FROM employees WHERE emp_id = ?`,
      [adEmpId],
    );
    if (byAdId) {
      return deriveEmpIdHashFromSam(adUser);
    }
  }

  return deriveEmpIdHashFromSam(adUser);
}

/** Insert or revive an AD identity link (handles soft-deleted rows on uk_system_external). */
async function upsertAdIdentityLink(empId: string, sam: string, linkStatus: string): Promise<void> {
  await execute(
    `INSERT INTO identity_links (emp_id, \`system\`, external_id, status, auth_kind, last_synced_at)
     VALUES (?, 'AD', ?, ?, 'LDAP', UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE
       emp_id = VALUES(emp_id),
       status = VALUES(status),
       auth_kind = VALUES(auth_kind),
       last_synced_at = UTC_TIMESTAMP()`,
    [empId, sam, linkStatus],
  );
}

/** Link employees that were imported without an AD identity_link (e.g. after a failed insert). */
async function repairOrphanAdLinks(
  adUsers: Record<string, unknown>[],
  errors: string[],
  upnDomains: string[],
): Promise<number> {
  let repaired = 0;
  for (const adUser of adUsers) {
    const sam = getLdapAttr(adUser, 'sAMAccountName').trim();
    const email = resolveAdCorporateEmail(adUser, upnDomains);
    if (!sam) continue;

    const emp = await queryOne<{ emp_id: string }>(
      `SELECT emp_id FROM employees WHERE ${email ? 'email_corp = ? OR ' : ''}emp_id = ?`,
      email ? [email, deriveEmpIdHashFromSam(adUser)] : [deriveEmpIdHashFromSam(adUser)],
    );
    if (!emp) continue;

    const hasLink = await queryOne<{ id: number }>(
      `SELECT id FROM identity_links
        WHERE emp_id = ? AND \`system\` = 'AD' AND status != 'DELETED'`,
      [emp.emp_id],
    );
    if (hasLink) continue;

    const uac = parseInt(getLdapAttr(adUser, 'userAccountControl') || '512', 10);
    const linkStatus = (uac & 0x0002) !== 0 ? 'DISABLED' : 'ACTIVE';

    try {
      await upsertAdIdentityLink(emp.emp_id, sam, linkStatus);
      repaired++;
      logger.info({ empId: emp.emp_id, sam }, 'AD sync: repaired missing identity link');
    } catch (err) {
      errors.push(`${sam}: link repair failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return repaired;
}

/** Give each AD sAMAccountName its own employees row when multiple links share one emp_id. */
async function splitSharedAdEmpIdRows(
  adUsersBySam: Map<string, Record<string, unknown>>,
  upnDomains: string[],
  defaultEmailDomain: string,
  errors: string[],
): Promise<number> {
  const shared = await query<{ emp_id: string; link_count: number }>(
    `SELECT emp_id, COUNT(*) AS link_count FROM identity_links
      WHERE \`system\` = 'AD' AND status != 'DELETED'
      GROUP BY emp_id HAVING link_count > 1`,
    [],
  );
  let split = 0;
  for (const row of shared) {
    const links = await query<{ id: number; external_id: string; status: string }>(
      `SELECT id, external_id, status FROM identity_links
        WHERE emp_id = ? AND \`system\` = 'AD' AND status != 'DELETED'
        ORDER BY id ASC`,
      [row.emp_id],
    );
    for (let i = 1; i < links.length; i++) {
      const link = links[i];
      const sam = link.external_id.trim();
      const adUser = adUsersBySam.get(sam.toLowerCase());
      if (!adUser) continue;

      const newEmpId = deriveEmpIdHashFromSam(adUser);
      const already = await queryOne<{ emp_id: string }>(
        `SELECT emp_id FROM identity_links
          WHERE \`system\` = 'AD' AND external_id = ? AND status != 'DELETED'`,
        [sam],
      );
      if (already && already.emp_id === newEmpId) continue;

      const email = resolveAdCorporateEmail(adUser, upnDomains)
        || (sam && defaultEmailDomain ? `${sam}@${defaultEmailDomain.replace(/^@+/, '')}` : '')
        || `${sam}@ad-sync.local`;
      const emailCorp = email.includes('@') ? email : `${sam}@ad-sync.local`;
      const fullName = cleanAdDisplayName(adUser, sam);
      const { firstName, lastName } = readAdNameParts(adUser, fullName, sam);
      const adObjectGuid = readAdObjectGuid(adUser);
      const uac = parseInt(getLdapAttr(adUser, 'userAccountControl') || '512', 10);
      const disabled = (uac & 0x0002) !== 0;
      const department = getLdapAttr(adUser, 'department').trim().slice(0, 50) || null;
      const title = getLdapAttr(adUser, 'title').trim().slice(0, 100) || null;
      const ilgState = disabled ? ILGState.SUSPENDED_AUTO : ILGState.ACTIVE;
      const linkStatus = disabled ? 'DISABLED' : link.status;

      try {
        const emailTaken = await queryOne<{ emp_id: string }>(
          `SELECT emp_id FROM employees WHERE LOWER(TRIM(email_corp)) = ? AND emp_id != ?`,
          [emailCorp.trim().toLowerCase(), newEmpId],
        );
        const insertEmail = emailTaken ? `${sam}@ad-sync.local` : emailCorp;

        await execute(
          `INSERT INTO employees
             (emp_id, full_name, first_name, last_name, email_corp, dept_id, role, ad_object_guid,
              ilg_state, hrms_status, hire_date, employment_type, sync_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', UTC_DATE(), 'CORPORATE', ?)
           ON DUPLICATE KEY UPDATE
             full_name = VALUES(full_name),
             first_name = VALUES(first_name),
             last_name = VALUES(last_name),
             email_corp = VALUES(email_corp),
             dept_id = VALUES(dept_id),
             role = VALUES(role),
             ad_object_guid = COALESCE(VALUES(ad_object_guid), ad_object_guid),
             updated_at = UTC_TIMESTAMP()`,
          [
            newEmpId, fullName, firstName, lastName, insertEmail, department, title, adObjectGuid,
            ilgState, disabled ? 'DISABLED' : null,
          ],
        );
        await execute(
          `UPDATE identity_links SET emp_id = ?, status = ?, last_synced_at = UTC_TIMESTAMP() WHERE id = ?`,
          [newEmpId, linkStatus, link.id],
        );
        split++;
        logger.info({ from: row.emp_id, to: newEmpId, sam }, 'AD sync: split shared emp_id to dedicated AD account row');
      } catch (err) {
        errors.push(`${sam}: split shared emp_id failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return split;
}

/** Migrate AD-XXXX placeholder emp_ids to real AD employee IDs (inbound batch). */
async function repairPlaceholderEmpIds(
  adUsers: Record<string, unknown>[],
  errors: string[],
): Promise<number> {
  let migrated = 0;
  for (const adUser of adUsers) {
    const email = (getLdapAttr(adUser, 'mail') || getLdapAttr(adUser, 'userPrincipalName')).trim().toLowerCase();
    const adEmpId = readAdEmployeeId(adUser);
    if (!email || !adEmpId) continue;

    const row = await queryOne<{ emp_id: string }>(
      `SELECT emp_id FROM employees WHERE email_corp = ?`,
      [email],
    );
    if (!row || !row.emp_id.startsWith('AD-') || row.emp_id === adEmpId) continue;

    try {
      const outcome = await tryMigrateEmpId(row.emp_id, adEmpId, email);
      if (outcome === 'migrated' || outcome === 'merged') {
        migrated++;
        logger.info(
          { from: row.emp_id, to: adEmpId, email, outcome },
          'AD sync: migrated placeholder emp_id from AD attributes',
        );
      }
    } catch (err) {
      errors.push(
        `${row.emp_id} -> ${adEmpId}: emp_id migration failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return migrated;
}

/** Migrate all AD-XXXX rows in DB when AD reports a real employee id for that email. */
async function repairDatabasePlaceholderEmpIds(adapter: ADAdapter, errors: string[]): Promise<number> {
  const placeholders = await query<{ emp_id: string; email_corp: string }>(
    `SELECT emp_id, email_corp FROM employees
      WHERE emp_id LIKE 'AD-%' AND email_corp IS NOT NULL AND email_corp != ''`,
    [],
  );

  let migrated = 0;
  for (const emp of placeholders) {
    try {
      const entryResult = await adapter.getDirectoryEntryByEmail(emp.email_corp);
      if (!entryResult.success) continue;

      const adEmpId = readAdEmployeeId(entryResult.data as Record<string, unknown>);
      if (!adEmpId || adEmpId === emp.emp_id) continue;

      const outcome = await tryMigrateEmpId(emp.emp_id, adEmpId, emp.email_corp);
      if (outcome === 'migrated' || outcome === 'merged') {
        migrated++;
        logger.info(
          { from: emp.emp_id, to: adEmpId, email: emp.email_corp, outcome },
          'AD sync: database placeholder emp_id migrated',
        );
      }
    } catch (err) {
      errors.push(`${emp.emp_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return migrated;
}

/** Backfill AD links for employees already in DB but missing identity_links (any sync run). */
async function repairDatabaseOrphanAdLinks(adapter: ADAdapter, errors: string[]): Promise<number> {
  const orphans = await query<{ emp_id: string; email_corp: string }>(
    `SELECT e.emp_id, e.email_corp
       FROM employees e
      WHERE e.emp_id LIKE 'AD-%'
        AND e.email_corp IS NOT NULL
        AND e.email_corp != ''
        AND NOT EXISTS (
          SELECT 1 FROM identity_links il
           WHERE il.emp_id = e.emp_id
             AND il.\`system\` = 'AD'
             AND il.status != 'DELETED'
        )`,
    [],
  );

  let repaired = 0;
  for (const emp of orphans) {
    try {
      const result = await adapter.getUserByEmail(emp.email_corp);
      if (!result.success || !result.data?.externalId) {
        errors.push(
          `${emp.emp_id}: AD lookup by email failed — ${result.success ? 'no account' : result.error}`,
        );
        continue;
      }
      const linkStatus = result.data.active ? 'ACTIVE' : 'DISABLED';
      await upsertAdIdentityLink(emp.emp_id, result.data.externalId, linkStatus);
      repaired++;
      logger.info({ empId: emp.emp_id, sam: result.data.externalId }, 'AD sync: database orphan link repaired');
    } catch (err) {
      errors.push(`${emp.emp_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return repaired;
}

export interface AdOutboundAction {
  action: 'PROVISION' | 'DISABLE' | 'ENABLE' | 'NOOP';
  empId: string;
  fullName: string;
  emailCorp: string;
  deptId: string | null;
  role: string | null;
  externalId?: string | undefined;
  suggestedSam?: string | undefined;
  provisionOuRdn?: string | undefined;
  upnDomain?: string | undefined;
  /** When false, only link an existing AD account — do not create a new one. */
  allowCreate?: boolean | undefined;
}

export interface AdOutboundResult {
  empId: string;
  action: string;
  success: boolean;
  externalId?: string;
  error?: string;
}

/** Import person accounts from AD into employees + identity_links. */
async function importAdDirectoryUsers(
  adapter: ADAdapter,
  dirConfig: AdDirectoryConfig,
  cfg: Record<string, unknown>,
  errors: string[],
): Promise<{
  found: number;
  imported: number;
  linked: number;
  skipped: number;
  disabledImported: number;
  split: number;
  adAccounts: number;
  processed: number;
  succeeded: number;
  failed: number;
  repaired: number;
  migrated: number;
  diag: string;
}> {
  const syncScope = resolveAdSyncScope(cfg);
  const listResult = await adapter.listDirectoryUsers(syncScope);
  if (!listResult.success) {
    throw new Error(listResult.error ?? 'Failed to list AD users');
  }

  return processInboundAdUsers(listResult.data, dirConfig, errors, { adapter, cfg });
}

/** Apply inbound AD user objects (from direct LDAP or on-prem agent). */
export async function processInboundAdUsers(
  adUsers: Record<string, unknown>[],
  dirConfig: AdDirectoryConfig,
  errors: string[],
  options?: { adapter?: ADAdapter | null; cfg?: Record<string, unknown>; defaultEmailDomain?: string },
): Promise<{
  found: number;
  imported: number;
  linked: number;
  skipped: number;
  disabledImported: number;
  split: number;
  adAccounts: number;
  processed: number;
  succeeded: number;
  failed: number;
  repaired: number;
  migrated: number;
  diag: string;
}> {
  const adapter = options?.adapter ?? null;
  const upnDomains = options?.cfg
    ? parseAdUpnDomains(options.cfg, dirConfig)
    : parseAdUpnDomains({}, dirConfig);
  const defaultEmailDomain = options?.defaultEmailDomain ?? upnDomains[0] ?? resolveAdDefaultEmailDomain({}, dirConfig);
  const rawCount = adUsers.length;
  adUsers = adUsers.filter((u) => isImportableAdDirectoryUser(u));
  if (adUsers.length < rawCount) {
    logger.info(
      { rawCount, importable: adUsers.length, dropped: rawCount - adUsers.length },
      'AD sync inbound: filtered built-in / service LDAP rows',
    );
  }

  let imported = 0;
  let linked = 0;
  let skipped = 0;
  let disabledImported = 0;
  let split = 0;
  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  logger.info(
    { searchBase: dirConfig.searchBaseDn, count: adUsers.length },
    'AD sync inbound: listing directory users',
  );

  // One-time diagnostic: dump every populated attribute for the first user
  // so we can identify which AD attribute actually holds the employee ID.
  // The same content is surfaced in the run's error_summary so it's visible
  // in the connector UI without having to grep server logs.
  let diag = '';
  const diagSample = adUsers.find((u) => {
    const upn = getLdapAttr(u, 'userPrincipalName');
    const mail = getLdapAttr(u, 'mail');
    return upn.includes('@') || mail.includes('@');
  }) ?? adUsers[0];
  if (diagSample) {
    const sample = diagSample as Record<string, unknown>;
    const populated: Record<string, string> = {};
    for (const k of Object.keys(sample)) {
      const v = getLdapAttr(sample, k);
      if (v) populated[k] = v.length > 80 ? v.slice(0, 80) + '…' : v;
    }
    logger.info(
      { sam: getLdapAttr(sample, 'sAMAccountName'), populated },
      'AD sync inbound: first user — all populated attrs (diagnostic)',
    );
    diag =
      `Diag (sample ${getLdapAttr(sample, 'sAMAccountName') || '?'}): ` +
      Object.entries(populated)
        .map(([k, v]) => `${k}=${v}`)
        .join(' | ');
  }

  const buildTag = process.env['GIT_COMMIT'] ?? process.env['IMAGE_TAG'] ?? '';
  if (buildTag) {
    diag = diag ? `${diag} || api=${buildTag}` : `api=${buildTag}`;
  }

  // First pass: build a DN -> email map
  // can resolve `manager` (a DN) without an extra LDAP round-trip per user.
  const dnToEmail = new Map<string, string>();
  for (const adUser of adUsers) {
    const dn = getLdapAttr(adUser, 'dn');
    const mail = resolveAdCorporateEmail(adUser, upnDomains);
    if (dn && mail) dnToEmail.set(dn.toLowerCase(), mail);
  }

  // Track (adUser -> resolved empId) so the second pass can write manager_emp_id.
  const empIdByDn = new Map<string, string>();
  const adUsersBySam = new Map<string, Record<string, unknown>>();
  for (const u of adUsers) {
    const s = getLdapAttr(u, 'sAMAccountName').trim().toLowerCase();
    if (s) adUsersBySam.set(s, u as Record<string, unknown>);
  }

  for (const adUser of adUsers) {
    processed++;
    const sam = getLdapAttr(adUser, 'sAMAccountName').trim();
    const dn = getLdapAttr(adUser, 'dn');

    try {
      if (!sam) {
        skipped++;
        succeeded++;
        continue;
      }

      const email = resolveAdCorporateEmail(adUser, upnDomains)
        || (sam && defaultEmailDomain ? `${sam}@${defaultEmailDomain.replace(/^@+/, '')}` : '');
      if (!email && !sam) {
        skipped++;
        succeeded++;
        continue;
      }
      const emailCorp = email || `${sam}@ad-sync.local`;
      const emailNorm = emailCorp.trim().toLowerCase();

      const fullName = cleanAdDisplayName(adUser, sam);
      const { firstName, lastName } = readAdNameParts(adUser, fullName, sam);
      const adObjectGuid = readAdObjectGuid(adUser);
      const uac = parseInt(getLdapAttr(adUser, 'userAccountControl') || '512', 10);
      const disabled = (uac & 0x0002) !== 0;
      const department = getLdapAttr(adUser, 'department').trim().slice(0, 50) || null;
      const title      = getLdapAttr(adUser, 'title').trim().slice(0, 100) || null;

      const empId = await resolveEmpIdForAdUser(adUser, emailCorp, errors);
      if (!empId) {
        skipped++;
        succeeded++;
        continue;
      }
      let targetEmpId = empId;
      let exists = await queryOne<{ emp_id: string }>(
        `SELECT emp_id FROM employees WHERE emp_id = ?`,
        [targetEmpId],
      );

      if (disabled) {
        const disabledState = ILGState.SUSPENDED_AUTO;
        if (exists) {
          await execute(
            `UPDATE employees
                SET full_name = ?, first_name = ?, last_name = ?, email_corp = ?, dept_id = ?, role = ?,
                    ad_object_guid = COALESCE(?, ad_object_guid),
                    sync_status = 'DISABLED', updated_at = UTC_TIMESTAMP()
              WHERE emp_id = ?`,
            [fullName, firstName, lastName, emailCorp, department, title, adObjectGuid, targetEmpId],
          );
          await upsertAdIdentityLink(targetEmpId, sam, 'DISABLED');
          await applyDirectorySourceDisabled(targetEmpId, 'AD', 'ad_account_disabled');
          linked++;
        } else {
          try {
            await execute(
              `INSERT INTO employees
                 (emp_id, full_name, first_name, last_name, email_corp, dept_id, role, ad_object_guid,
                  ilg_state, hrms_status, hire_date, employment_type, sync_status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', UTC_DATE(), 'CORPORATE', 'DISABLED')`,
              [targetEmpId, fullName, firstName, lastName, emailCorp, department, title, adObjectGuid, disabledState],
            );
            await upsertAdIdentityLink(targetEmpId, sam, 'DISABLED');
            disabledImported++;
            imported++;
          } catch (err) {
            if (isDuplicateKeyError(err) && emailNorm) {
              const byEmail = await queryOne<{ emp_id: string }>(
                `SELECT emp_id FROM employees WHERE LOWER(TRIM(email_corp)) = ?`,
                [emailNorm],
              );
              if (byEmail) {
                targetEmpId = byEmail.emp_id;
                exists = byEmail;
                await execute(
                  `UPDATE employees
                      SET full_name = ?, first_name = ?, last_name = ?, dept_id = ?, role = ?,
                          ad_object_guid = COALESCE(?, ad_object_guid),
                          sync_status = 'DISABLED', updated_at = UTC_TIMESTAMP()
                    WHERE emp_id = ?`,
                  [fullName, firstName, lastName, department, title, adObjectGuid, targetEmpId],
                );
                await upsertAdIdentityLink(targetEmpId, sam, 'DISABLED');
                await applyDirectorySourceDisabled(targetEmpId, 'AD', 'ad_account_disabled');
                linked++;
              } else {
                throw err;
              }
            } else {
              throw err;
            }
          }
        }
        succeeded++;
        continue;
      }

      const existingState = exists
        ? (await queryOne<{ ilg_state: string }>(
          `SELECT ilg_state FROM employees WHERE emp_id = ?`,
          [targetEmpId],
        ))?.ilg_state
        : undefined;

      if (existingState === ILGState.SUSPENDED_AUTO) {
        await applyDirectorySourceEnabled(targetEmpId, 'AD');
      }

      const linkStatus = 'ACTIVE';
      const ilgState = existingState
        ? preserveIlgStateOnDirectoryImport(existingState)
        : ILGState.ACTIVE;

      if (exists) {
        await execute(
          `UPDATE employees
              SET full_name = ?, first_name = ?, last_name = ?, email_corp = ?, dept_id = ?, role = ?,
                  ad_object_guid = COALESCE(?, ad_object_guid),
                  ilg_state = ?, updated_at = UTC_TIMESTAMP()
            WHERE emp_id = ?`,
          [fullName, firstName, lastName, emailCorp, department, title, adObjectGuid, ilgState, targetEmpId],
        );
        linked++;
      } else {
        try {
          await execute(
            `INSERT INTO employees
               (emp_id, full_name, first_name, last_name, email_corp, dept_id, role, ad_object_guid,
                ilg_state, hrms_status, hire_date, employment_type)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', UTC_DATE(), 'CORPORATE')`,
            [targetEmpId, fullName, firstName, lastName, emailCorp, department, title, adObjectGuid, ilgState],
          );
          imported++;
        } catch (err) {
          if (isDuplicateKeyError(err) && emailNorm) {
            const byEmail = await queryOne<{ emp_id: string }>(
              `SELECT emp_id FROM employees WHERE LOWER(TRIM(email_corp)) = ?`,
              [emailNorm],
            );
            if (byEmail) {
              targetEmpId = byEmail.emp_id;
              await execute(
                `UPDATE employees
                    SET full_name = ?, first_name = ?, last_name = ?, dept_id = ?, role = ?,
                        ad_object_guid = COALESCE(?, ad_object_guid),
                        ilg_state = ?, updated_at = UTC_TIMESTAMP()
                  WHERE emp_id = ?`,
                [fullName, firstName, lastName, department, title, adObjectGuid, ilgState, targetEmpId],
              );
              linked++;
            } else {
              throw err;
            }
          } else {
            throw err;
          }
        }
      }

      // Always attach link to the resolved employee (moves link if it was on wrong emp_id)
      await upsertAdIdentityLink(targetEmpId, sam, linkStatus);
      if (dn) empIdByDn.set(dn.toLowerCase(), targetEmpId);
      succeeded++;
    } catch (err) {
      failed++;
      const msg = `${sam || dn}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      logger.error({ sam, dn, err }, 'AD sync inbound: user import failed');
    }
  }

  // Second pass: resolve `manager` DN -> manager's emp_id and write it.
  // Done after the first pass so a manager that appears later in the batch
  // is already inserted.
  let managersLinked = 0;
  for (const adUser of adUsers) {
    const dn = getLdapAttr(adUser, 'dn');
    const managerDn = getLdapAttr(adUser, 'manager').trim();
    if (!dn || !managerDn) continue;
    const empId = empIdByDn.get(dn.toLowerCase());
    if (!empId) continue;

    let managerEmpId = empIdByDn.get(managerDn.toLowerCase()) ?? null;
    if (!managerEmpId) {
      const managerEmail = dnToEmail.get(managerDn.toLowerCase());
      if (managerEmail) {
        const row = await queryOne<{ emp_id: string }>(
          `SELECT emp_id FROM employees WHERE email_corp = ?`,
          [managerEmail],
        );
        managerEmpId = row?.emp_id ?? null;
      }
    }
    if (!managerEmpId || managerEmpId === empId) continue;

    try {
      await execute(
        `UPDATE employees SET manager_emp_id = ? WHERE emp_id = ?`,
        [managerEmpId, empId],
      );
      managersLinked++;
    } catch (err) {
      errors.push(`${empId}: manager link failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (managersLinked > 0) {
    logger.info({ managersLinked }, 'AD sync inbound: manager links resolved');
  }

  split = await splitSharedAdEmpIdRows(adUsersBySam, upnDomains, defaultEmailDomain, errors);
  if (split > 0) {
    logger.info({ split }, 'AD sync inbound: split AD accounts sharing one emp_id');
  }

  const repaired = await repairOrphanAdLinks(adUsers as Record<string, unknown>[], errors, upnDomains);
  if (repaired > 0) {
    logger.info({ repaired }, 'AD sync inbound: repaired orphan identity links');
  }

  let dbRepaired = 0;
  let dbMigrated = 0;
  if (adapter) {
    dbRepaired = await repairDatabaseOrphanAdLinks(adapter, errors);
    if (dbRepaired > 0) {
      logger.info({ dbRepaired }, 'AD sync inbound: repaired database orphan identity links');
    }
    dbMigrated = await repairDatabasePlaceholderEmpIds(adapter, errors);
    if (dbMigrated > 0) {
      logger.info({ dbMigrated }, 'AD sync inbound: migrated database placeholder emp_ids');
    }
  }

  const migrated = await repairPlaceholderEmpIds(adUsers as Record<string, unknown>[], errors);
  if (migrated > 0) {
    logger.info({ migrated }, 'AD sync inbound: migrated placeholder emp_ids');
  }

  const adAccounts = Number(
    (await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM identity_links WHERE \`system\` = 'AD' AND status != 'DELETED'`,
      [],
    ))?.n ?? 0,
  );

  return {
    found: adUsers.length,
    imported,
    linked,
    skipped,
    disabledImported,
    split,
    adAccounts,
    processed,
    succeeded,
    failed,
    repaired: repaired + dbRepaired,
    migrated: migrated + dbMigrated,
    diag,
  };
}

// ---------------------------------------------------------------------------
// Adapter factory + on-demand link backfill
// ---------------------------------------------------------------------------
function loadConnectorConfig(connectorId: string): Promise<Record<string, unknown>> {
  return queryOne<{ config_json: string | Record<string, unknown> }>(
    `SELECT config_json FROM connectors WHERE id = ?`,
    [connectorId],
  ).then((connRow) =>
    connRow
      ? typeof connRow.config_json === 'string'
        ? JSON.parse(connRow.config_json || '{}') as Record<string, unknown>
        : (connRow.config_json ?? {})
      : {},
  );
}

function createAdAdapterFromConfig(cfg: Record<string, unknown>): ADAdapter {
  const host       = (cfg['host'] as string | undefined)?.trim()     || new URL(config.ad.url).hostname;
  const useSsl     = parseConnectorBoolean(cfg['useSsl'], config.ad.url.startsWith('ldaps'));
  const startTls   = parseConnectorBoolean(cfg['startTls'], false);
  const port       = parseConnectorPort(cfg['port'], useSsl ? 636 : 389);
  const bindDn     = (cfg['bindDn']       as string | undefined) || config.ad.bindDn;
  const bindPass   = (cfg['bindPassword'] as string | undefined) || config.ad.bindPassword;
  const baseDn     = (cfg['baseDn']       as string | undefined) || config.ad.baseDn;
  const targetOuRaw = (cfg['targetOu'] as string | undefined)?.trim() ?? '';
  const adUrl      = `${useSsl ? 'ldaps' : 'ldap'}://${host}:${port}`;

  return new ADAdapter(
    redis,
    adUrl,
    bindDn,
    bindPass,
    baseDn,
    undefined,
    startTls,
    targetOuRaw,
  );
}

/** Backfill AD identity link and correct placeholder emp_id when viewing a profile. */
export async function backfillAdIdentityLinkIfMissing(
  empId: string,
  emailCorp: string,
): Promise<{ empId: string; changed: boolean }> {
  if (!emailCorp) return { empId, changed: false };

  const conn = await queryOne<{ id: string }>(
    `SELECT id FROM connectors
      WHERE connector_type IN ('AD', 'LDAP') AND status IN ('ACTIVE', 'CONNECTED', 'CONFIGURED')
      ORDER BY
        CASE status
          WHEN 'ACTIVE' THEN 0
          WHEN 'CONNECTED' THEN 1
          ELSE 2
        END,
        last_sync_at DESC,
        updated_at DESC
      LIMIT 1`,
    [],
  );
  if (!conn) return { empId, changed: false };

  const cfg = await loadConnectorConfig(conn.id);
  const adapter = createAdAdapterFromConfig(cfg);

  try {
    await adapter.resetCircuitBreaker();
    await adapter.connect();

    let entry: Record<string, unknown> | null = null;

    const byEmail = await adapter.getDirectoryEntryByEmail(emailCorp);
    if (byEmail.success) {
      entry = byEmail.data as Record<string, unknown>;
    }

    if (!entry && empId && !empId.startsWith('AD-')) {
      const byEmpId = await adapter.getUser(empId);
      if (byEmpId.success && byEmpId.data?.sAMAccountName) {
        const bySam = await adapter.getUserBySam(String(byEmpId.data.sAMAccountName));
        if (bySam.success) entry = bySam.data as Record<string, unknown>;
      }
    }

    if (!entry) {
      const existingLink = await queryOne<{ external_id: string }>(
        `SELECT external_id FROM identity_links
          WHERE emp_id = ? AND \`system\` = 'AD' AND status != 'DELETED'`,
        [empId],
      );
      if (existingLink?.external_id) {
        const bySam = await adapter.getUserBySam(existingLink.external_id);
        if (bySam.success) entry = bySam.data as Record<string, unknown>;
      }
    }

    if (!entry) return { empId, changed: false };

    const adEmpId = readAdEmployeeId(entry);
    const sam = getLdapAttr(entry, 'sAMAccountName');
    if (!sam) return { empId, changed: false };

    let targetEmpId = empId;
    let changed = false;

    if (adEmpId && empId.startsWith('AD-') && empId !== adEmpId) {
      const outcome = await tryMigrateEmpId(empId, adEmpId, emailCorp);
      if (outcome === 'migrated' || outcome === 'merged') {
        targetEmpId = adEmpId;
        changed = true;
        logger.info({ from: empId, to: adEmpId, emailCorp, outcome }, 'AD emp_id migrated on profile load');
      }
    }

    const hasLink = await queryOne<{ id: number }>(
      `SELECT id FROM identity_links
        WHERE emp_id = ? AND \`system\` = 'AD' AND status != 'DELETED'`,
      [targetEmpId],
    );
    if (!hasLink) {
      const uac = parseInt(getLdapAttr(entry, 'userAccountControl') || '512', 10);
      const linkStatus = (uac & 0x0002) !== 0 ? 'DISABLED' : 'ACTIVE';
      await upsertAdIdentityLink(targetEmpId, sam, linkStatus);
      changed = true;
      logger.info({ empId: targetEmpId, sam }, 'AD identity link backfilled for profile');
    }

    const cleanName = cleanAdDisplayName(entry, sam);
    const adEmail = resolveAdCorporateEmail(entry);
    await execute(
      `UPDATE employees
          SET full_name = ?,
              email_corp = CASE WHEN ? != '' THEN ? ELSE email_corp END,
              updated_at = UTC_TIMESTAMP()
        WHERE emp_id = ?`,
      [cleanName, adEmail, adEmail, targetEmpId],
    );

    return { empId: targetEmpId, changed };
  } catch (err) {
    logger.warn({ empId, emailCorp, err }, 'AD identity link backfill failed');
    return { empId, changed: false };
  } finally {
    await adapter.disconnect().catch(() => undefined);
  }
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
  const connRow = await queryOne<{ config_json: string | Record<string, unknown>; direction: string }>(
    `SELECT config_json, direction FROM connectors WHERE id = ?`,
    [connectorId],
  );
  const cfg: Record<string, unknown> = connRow
    ? typeof connRow.config_json === 'string'
      ? JSON.parse(connRow.config_json || '{}') as Record<string, unknown>
      : (connRow.config_json ?? {})
    : {};

  const direction = (connRow?.direction ?? 'BIDIRECTIONAL').toUpperCase();
  const runInbound  = direction === 'INBOUND' || direction === 'BIDIRECTIONAL';
  const runOutbound = direction === 'OUTBOUND' || direction === 'BIDIRECTIONAL';

  if (!runInbound && direction === 'OUTBOUND') {
    logger.info({ connectorId, direction }, 'AD sync: OUTBOUND-only — skipping AD directory import');
  }

  const targetOuRaw = (cfg['targetOu'] as string | undefined)?.trim() ?? '';
  const baseDn     = (cfg['baseDn']       as string | undefined) || config.ad.baseDn;
  let dirConfig: ReturnType<typeof resolveAdDirectoryConfig>;
  try {
    dirConfig = resolveAdDirectoryConfig(baseDn, targetOuRaw);
  } catch (err) {
    const runErr = err instanceof Error ? err.message : String(err);
    await execute(
      `UPDATE connector_runs SET status = 'FAILED', ended_at = UTC_TIMESTAMP(), error_summary = ? WHERE id = ?`,
      [runErr, runId],
    );
    throw err;
  }

  const upnDomains = parseAdUpnDomains(cfg, dirConfig);

  const host       = (cfg['host'] as string | undefined)?.trim()     || new URL(config.ad.url).hostname;
  const useSsl     = parseConnectorBoolean(cfg['useSsl'], config.ad.url.startsWith('ldaps'));
  const startTls   = parseConnectorBoolean(cfg['startTls'], false);
  const port       = parseConnectorPort(cfg['port'], useSsl ? 636 : 389);
  const adUrl      = `${useSsl ? 'ldaps' : 'ldap'}://${host}:${port}`;

  logger.info(
    { connectorId, adUrl, bindDn: cfg['bindDn'], baseDn: dirConfig.searchBaseDn, provisionOu: dirConfig.provisionOuDn, direction, startTls },
    'AD sync: connecting',
  );

  const adapter = createAdAdapterFromConfig(cfg);

  // Clear any OPEN circuit from a prior failed run so this sync gets a fresh attempt
  await adapter.resetCircuitBreaker();

  let itemsProcessed = 0;
  let itemsSucceeded = 0;
  let itemsFailed = 0;
  const errors: string[] = [];
  let inboundSummary = '';
  let outboundProcessed = 0;
  let outboundSkipped = 0;
  let outboundFailed = 0;
  const syncScope = resolveAdSyncScope(cfg);

  try {
    await adapter.connect();

    if (runInbound) {
      const inbound = await importAdDirectoryUsers(adapter, dirConfig, cfg, errors);
      itemsProcessed += inbound.processed;
      itemsSucceeded += inbound.succeeded;
      itemsFailed += inbound.failed;
      const searchBases = resolveAdSearchBases(syncScope, dirConfig);
      const ldapScope = resolveAdLdapScope(syncScope);
      inboundSummary =
        `Inbound (${ldapScope}-tree, ${searchBases.length} base(s): ${searchBases.slice(0, 2).join('; ')}${searchBases.length > 2 ? '…' : ''}): ` +
        `${inbound.found} AD accounts, ${inbound.adAccounts} linked in directory` +
        (inbound.imported ? `, ${inbound.imported} imported` : '') +
        (inbound.linked ? `, ${inbound.linked} updated` : '') +
        (inbound.disabledImported ? ` (${inbound.disabledImported} disabled)` : '') +
        (inbound.split ? `, ${inbound.split} split to own row` : '') +
        (inbound.repaired ? `, ${inbound.repaired} links repaired` : '') +
        (inbound.migrated ? `, ${inbound.migrated} emp_ids corrected` : '') +
        (inbound.skipped ? `, ${inbound.skipped} skipped (no sAMAccountName)` : '') +
        (inbound.diag ? ` || ${inbound.diag}` : '') +
        (runOutbound ? ` | Outbound: see employee reconcile below` : '');
      logger.info({ connectorId, runId, ...inbound }, 'AD sync inbound complete');

      if (inbound.found === 0) {
        errors.push(
          `Inbound: 0 users returned from AD under ${dirConfig.searchBaseDn}. ` +
          `Set Base DN to domain root (DC=Lenskart,DC=in) or the OU containing users (OU=IT,DC=Lenskart,DC=in).`,
        );
      } else if (inbound.found === 1000) {
        errors.push(
          'Inbound: exactly 1000 AD users — likely hitting pre-pagination API build. Redeploy latest idp-api image and re-run sync.',
        );
      }

      const { syncAdDirectoryGroups } = await import('./group-sync.js');
      const gs = await syncAdDirectoryGroups(connectorId, cfg as Record<string, unknown>);
      inboundSummary += formatAdGroupSyncSummary(cfg as Record<string, unknown>, gs);
      if (gs.errors.length) errors.push(...gs.errors);
    }

    if (runOutbound) {
    const googleLinked = new Set(
      (await query<{ emp_id: string }>(
        `SELECT emp_id FROM identity_links
          WHERE \`system\` = 'GOOGLE' AND status NOT IN ('DELETED')`,
        [],
      )).map((r) => r.emp_id),
    );

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
        if (link) continue;
        if (!employeeEligibleForAdProvision(emp.email_corp, syncScope, googleLinked.has(emp.emp_id))) {
          continue;
        }
        return true;
      }
      return false;
    })();

    if (needsProvisioning) {
      const ouCheck = await adapter.validateProvisioningOu();
      if (!ouCheck.ok) {
        const hint = ouCheck.suggestions.length
          ? ` Existing OUs: ${ouCheck.suggestions.slice(0, 6).join('; ')}`
          : '';
        throw new Error(
          `Target OU does not exist: ${ouCheck.ouDn}. Create it in Active Directory or update connector "New User OU".${hint}`,
        );
      }
      if (ouCheck.inferredProvisionOu) {
        logger.info(
          { provisionOuDn: ouCheck.ouDn },
          'AD sync: New User OU inferred from Base DN — consider setting Base DN to domain root and New User OU explicitly',
        );
      }
    }

    logger.info({ connectorId, runId, count: employees.length }, 'AD sync: processing employees');

    for (const emp of employees) {
      itemsProcessed++;
      outboundProcessed++;

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
            await upsertAdIdentityLink(emp.emp_id, existingSam, 'ACTIVE');
            logger.info({ empId: emp.emp_id, existingSam }, 'AD sync: existing AD user reconciled and linked');
            itemsSucceeded++;
          } else if (!employeeEligibleForAdProvision(emp.email_corp, syncScope, googleLinked.has(emp.emp_id))) {
            outboundSkipped++;
            itemsSucceeded++;
            logger.debug(
              { empId: emp.emp_id, email: emp.email_corp },
              'AD sync: skipped outbound provision (Google-only or out of sync scope)',
            );
          } else {
            // No AD account found — provision a new one
            const sAMAccountName = generateSamAccountName(emp.full_name);
            const tempPass = generateTempPassword();

            const provisionUpn = resolveUpnSuffixForProvision(emp.email_corp, upnDomains);
            const result = await adapter.createUser({
              empId:        emp.emp_id,
              fullName:     emp.full_name,
              emailCorp:    emp.email_corp,
              sAMAccountName,
              department:   emp.dept_id ?? '',
              title:        emp.role ?? '',
              targetOu: dirConfig.provisionOuRdn,
              upnDomain: provisionUpn,
              tempPassword: tempPass,
            });

            if (result.success) {
              await upsertAdIdentityLink(emp.emp_id, sAMAccountName, 'ACTIVE');
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
        outboundFailed++;
        const msg = `${emp.emp_id}: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(msg);
        logger.error({ empId: emp.emp_id, err }, 'AD sync: per-employee error (non-fatal)');
      }
    }
    } // runOutbound

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
  const outboundSummary = runOutbound && outboundProcessed > 0
    ? `Outbound: ${outboundProcessed} employees checked` +
      (outboundSkipped ? `, ${outboundSkipped} skipped (no AD provision needed)` : '') +
      (outboundFailed ? `, ${outboundFailed} failed` : '')
    : '';
  const summaryParts = [
    inboundSummary,
    outboundSummary,
  ].filter(Boolean);
  const errorSummary = errors.length > 0
    ? [...summaryParts, errors.slice(0, 8).join('; ')].filter(Boolean).join(' | ')
    : summaryParts.join(' | ') || null;

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

/** Build outbound reconcile actions for the on-prem AD agent (no direct LDAP from IdP). */
export async function buildAdOutboundPlanForAgent(
  dirConfig: AdDirectoryConfig,
  cfg: Record<string, unknown>,
): Promise<AdOutboundAction[]> {
  const upnDomains = parseAdUpnDomains(cfg, dirConfig);

  const syncScope = resolveAdSyncScope(cfg);
  const googleLinked = new Set(
    (await query<{ emp_id: string }>(
      `SELECT emp_id FROM identity_links
        WHERE \`system\` = 'GOOGLE' AND status NOT IN ('DELETED')`,
      [],
    )).map((r) => r.emp_id),
  );

  const employees = await query<EmployeeRow>(
    `SELECT emp_id, full_name, email_corp, dept_id, role, ilg_state
       FROM employees
      ORDER BY emp_id`,
    [],
  );

  const plan: AdOutboundAction[] = [];

  for (const emp of employees) {
    const link = await queryOne<IdentityLinkRow>(
      `SELECT id, external_id, status
         FROM identity_links
        WHERE emp_id = ? AND \`system\` = 'AD' AND status NOT IN ('DELETED')`,
      [emp.emp_id],
    );

    const isActive = emp.ilg_state === 'ACTIVE' || emp.ilg_state === 'REACTIVATED';
    const isInactive = emp.ilg_state === 'SUSPENDED_HR'
      || emp.ilg_state === 'SUSPENDED_AUTO'
      || emp.ilg_state === 'DEPARTED'
      || emp.ilg_state === 'DEPROVISIONED';

    if (isActive && !link) {
      const allowCreate = employeeEligibleForAdProvision(
        emp.email_corp,
        syncScope,
        googleLinked.has(emp.emp_id),
      );
      plan.push({
        action: 'PROVISION',
        empId: emp.emp_id,
        fullName: emp.full_name,
        emailCorp: emp.email_corp,
        deptId: emp.dept_id,
        role: emp.role,
        suggestedSam: generateSamAccountName(emp.full_name),
        provisionOuRdn: dirConfig.provisionOuRdn,
        allowCreate,
        upnDomain: resolveUpnSuffixForProvision(emp.email_corp, upnDomains),
      });
    } else if (isInactive && link && link.status === 'ACTIVE') {
      plan.push({
        action: 'DISABLE',
        empId: emp.emp_id,
        fullName: emp.full_name,
        emailCorp: emp.email_corp,
        deptId: emp.dept_id,
        role: emp.role,
        externalId: link.external_id,
      });
    } else if (isActive && link && link.status === 'DISABLED') {
      plan.push({
        action: 'ENABLE',
        empId: emp.emp_id,
        fullName: emp.full_name,
        emailCorp: emp.email_corp,
        deptId: emp.dept_id,
        role: emp.role,
        externalId: link.external_id,
      });
    } else {
      plan.push({
        action: 'NOOP',
        empId: emp.emp_id,
        fullName: emp.full_name,
        emailCorp: emp.email_corp,
        deptId: emp.dept_id,
        role: emp.role,
        ...(link?.external_id ? { externalId: link.external_id } : {}),
      });
    }
  }

  return plan;
}

/** Apply outbound results reported by the on-prem AD agent. */
export async function applyAdOutboundResultsFromAgent(
  results: AdOutboundResult[],
): Promise<{ processed: number; succeeded: number; failed: number; errors: string[] }> {
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const r of results) {
    if (r.action === 'NOOP') {
      processed++;
      succeeded++;
      continue;
    }

    processed++;

    if (!r.success) {
      failed++;
      errors.push(`${r.empId}: ${r.error ?? 'agent reported failure'}`);
      continue;
    }

    try {
      if (r.action === 'PROVISION' || r.action === 'LINK') {
        const sam = r.externalId?.trim();
        if (!sam) throw new Error('missing externalId (sAMAccountName) after provision/link');
        await upsertAdIdentityLink(r.empId, sam, 'ACTIVE');
        succeeded++;
      } else if (r.action === 'DISABLE') {
        const link = await queryOne<IdentityLinkRow>(
          `SELECT id FROM identity_links
            WHERE emp_id = ? AND \`system\` = 'AD' AND status = 'ACTIVE'`,
          [r.empId],
        );
        if (link) {
          await execute(`UPDATE identity_links SET status = 'DISABLED' WHERE id = ?`, [link.id]);
        }
        succeeded++;
      } else if (r.action === 'ENABLE') {
        const link = await queryOne<IdentityLinkRow>(
          `SELECT id FROM identity_links
            WHERE emp_id = ? AND \`system\` = 'AD' AND status = 'DISABLED'`,
          [r.empId],
        );
        if (link) {
          await execute(`UPDATE identity_links SET status = 'ACTIVE' WHERE id = ?`, [link.id]);
        }
        succeeded++;
      } else {
        succeeded++;
      }
    } catch (err) {
      failed++;
      errors.push(`${r.empId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { processed, succeeded, failed, errors };
}
