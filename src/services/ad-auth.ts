/**
 * Active Directory credential verification for portal login.
 * AD-synced employees may not have a local_accounts row until first login or admin reset.
 */

import { getLdapAttr } from '../adapters/ad-adapter.js';
import { config } from '../config.js';
import { queryOne, execute } from '../db/connection.js';
import { redis } from '../auth/session-store.js';
import logger from '../utils/logger.js';
import { hashPassword } from './local-admin.js';
import { backfillAdIdentityLinkIfMissing } from './ad-sync.js';
import { isPortalAccessible } from '../fsm/states.js';
import {
  createAdAdapterFromConfig,
  isPlainLdapConnector,
  listAdLdapConnectionAttempts,
  parseAndNormalizeAdConnectorConfig,
} from './ad-ldap-connect.js';

const VALID_ROLES = new Set(['USER', 'MANAGER', 'HRBP', 'ADMIN', 'SUPER_ADMIN']);

function resolveBindPassword(cfg: Record<string, unknown>): string {
  const raw = String(cfg['bindPassword'] ?? '').trim();
  if (!raw || raw === '••••••••') return config.ad.bindPassword;
  return raw;
}

async function loadActiveAdConnectorConfig(): Promise<Record<string, unknown> | null> {
  const row = await queryOne<{ config_json: string | Record<string, unknown> }>(
    `SELECT config_json FROM connectors
      WHERE connector_type IN ('AD', 'LDAP') AND status IN ('ACTIVE', 'CONNECTED', 'CONFIGURED')
      ORDER BY
        CASE status
          WHEN 'ACTIVE' THEN 0
          WHEN 'CONNECTED' THEN 1
          ELSE 2
        END,
        updated_at DESC
      LIMIT 1`,
    [],
  );
  if (!row) return null;
  return parseAndNormalizeAdConnectorConfig(row.config_json);
}

export interface AdLoginAccount {
  id:            number;
  emp_id:        string;
  email:         string;
  password_hash: string;
  role:          string;
  active:        number;
  ilg_state:     string;
  hrms_status:   string;
}

/** Structured AD login outcome — never collapse infra/password failures into "no account". */
export type AdCorporateAuthResult =
  | { status: 'ok'; account: AdLoginAccount }
  | { status: 'no_employee' }
  | { status: 'not_accessible'; ilg_state: string }
  | { status: 'no_connector' }
  | { status: 'bad_credentials'; detail?: string }
  | { status: 'unavailable'; detail?: string };

function isAdTransientFailure(msg: string): boolean {
  return /ECONNRESET|ECONNABORTED|EPIPE|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|socket hang up|connection (?:closed|reset|timed? ?out)|timed? ?out|unavailable|Circuit open|LDAP_SERVER_DOWN|connect\s+E/i
    .test(msg);
}

function isAdInvalidCredentials(msg: string): boolean {
  return /invalidCredentials|LDAP_INVALID_CREDENTIALS|\b49e?\b|data 52e|data 532|data 533|data 701|data 773|AcceptSecurityContext|80090308|logon failure|bad password|wrong password|credential/i
    .test(msg);
}

function classifyAdVerifyFailure(detail: string | undefined): 'bad_credentials' | 'unavailable' {
  const msg = detail ?? '';
  if (isAdInvalidCredentials(msg) && !isAdTransientFailure(msg)) {
    return 'bad_credentials';
  }
  if (isAdTransientFailure(msg)) {
    return 'unavailable';
  }
  // Ambiguous LDAP bind failures after a known employee row — treat as bad credentials
  // (do not claim the account is missing).
  if (isAdInvalidCredentials(msg)) {
    return 'bad_credentials';
  }
  return 'unavailable';
}

async function upsertAdIdentityLink(empId: string, sam: string): Promise<void> {
  await execute(
    `INSERT INTO identity_links (emp_id, \`system\`, external_id, status, auth_kind, last_synced_at)
     VALUES (?, 'AD', ?, 'ACTIVE', 'LDAP', UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE
       external_id = VALUES(external_id),
       status = 'ACTIVE',
       last_synced_at = UTC_TIMESTAMP()`,
    [empId, sam],
  );
}

async function verifyAdLoginPassword(
  cfg: Record<string, unknown>,
  email: string,
  password: string,
  samHint?: string,
): Promise<{ ok: boolean; error?: string }> {
  const errors: string[] = [];

  const allowFallback = !isPlainLdapConnector(cfg);
  for (const attempt of listAdLdapConnectionAttempts(cfg, allowFallback)) {
    const adapter = createAdAdapterFromConfig(redis, { ...cfg, bindPassword: resolveBindPassword(cfg) }, attempt);
    try {
      await adapter.resetCircuitBreaker();

      const direct = await adapter.verifyUserCredentialsByEmail(email, password);
      if (direct.success) {
        return { ok: true };
      }
      if (direct.error) errors.push(`[${attempt.label}/upn] ${direct.error}`);

      if (samHint) {
        await adapter.connect();
        const bySam = await adapter.verifyUserCredentials(samHint, password);
        if (bySam.success) {
          return { ok: true };
        }
        if (bySam.error) errors.push(`[${attempt.label}/sam] ${bySam.error}`);
      }

      await adapter.connect();
      const entryResult = await adapter.getDirectoryEntryByEmail(email);
      if (entryResult.success) {
        const entry = entryResult.data as Record<string, unknown>;
        const sam = getLdapAttr(entry, 'sAMAccountName');
        if (sam) {
          const byEntry = await adapter.verifyUserCredentials(sam, password);
          if (byEntry.success) {
            return { ok: true };
          }
          if (byEntry.error) errors.push(`[${attempt.label}/lookup] ${byEntry.error}`);
        }
      } else if (entryResult.error) {
        errors.push(`[${attempt.label}/lookup] ${entryResult.error}`);
      }
    } catch (err) {
      errors.push(`[${attempt.label}] ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await adapter.disconnect().catch(() => undefined);
    }
  }

  return { ok: false, error: errors.join(' | ') || 'AD login verification failed' };
}

async function verifyAdLoginPasswordWithRetry(
  cfg: Record<string, unknown>,
  email: string,
  password: string,
  samHint?: string,
): Promise<{ ok: boolean; error?: string }> {
  const first = await verifyAdLoginPassword(cfg, email, password, samHint);
  if (first.ok) return first;
  if (!isAdTransientFailure(first.error ?? '')) return first;

  logger.warn(
    { email, error: first.error },
    'AD corporate login: transient LDAP failure — retrying once',
  );
  await new Promise((r) => setTimeout(r, 400));
  return verifyAdLoginPassword(cfg, email, password, samHint);
}

/**
 * Verify corporate email + password against Active Directory and provision a local_accounts
 * row so MFA and future local-hash logins work.
 */
export async function authenticateAdCorporateUser(
  email: string,
  password: string,
): Promise<AdCorporateAuthResult> {
  const normalizedEmail = email.toLowerCase().trim();

  const employee = await queryOne<{
    emp_id: string;
    email_corp: string;
    role: string | null;
    ilg_state: string;
    hrms_status: string;
  }>(
    `SELECT emp_id, email_corp, role, ilg_state, hrms_status
       FROM employees WHERE LOWER(email_corp) = ?`,
    [normalizedEmail],
  );
  if (!employee) {
    logger.info({ email: normalizedEmail }, 'AD login: no employee row for corporate email');
    return { status: 'no_employee' };
  }
  if (!isPortalAccessible(employee.ilg_state)) {
    logger.info({ email: normalizedEmail, ilg_state: employee.ilg_state }, 'AD login: employee not portal-accessible');
    return { status: 'not_accessible', ilg_state: employee.ilg_state };
  }

  const cfg = await loadActiveAdConnectorConfig();
  if (!cfg) {
    logger.warn({ email: normalizedEmail }, 'AD login: no AD/LDAP connector config found');
    return { status: 'no_connector' };
  }

  const { empId: effectiveEmpId } = await backfillAdIdentityLinkIfMissing(
    employee.emp_id,
    normalizedEmail,
  );

  const adLink = await queryOne<{ external_id: string }>(
    `SELECT external_id FROM identity_links
      WHERE emp_id = ? AND \`system\` = 'AD' AND status = 'ACTIVE'`,
    [effectiveEmpId],
  );

  const verified = await verifyAdLoginPasswordWithRetry(
    cfg,
    normalizedEmail,
    password,
    adLink?.external_id,
  );
  if (!verified.ok) {
    const kind = classifyAdVerifyFailure(verified.error);
    logger.warn(
      { email: normalizedEmail, empId: effectiveEmpId, error: verified.error, kind },
      'AD corporate login failed',
    );
    if (kind === 'bad_credentials') {
      return verified.error
        ? { status: 'bad_credentials', detail: verified.error }
        : { status: 'bad_credentials' };
    }
    return verified.error
      ? { status: 'unavailable', detail: verified.error }
      : { status: 'unavailable' };
  }

  if (!adLink?.external_id) {
    const adapter = createAdAdapterFromConfig(redis, { ...cfg, bindPassword: resolveBindPassword(cfg) });
    try {
      await adapter.resetCircuitBreaker();
      await adapter.connect();
      const entryResult = await adapter.getDirectoryEntryByEmail(normalizedEmail);
      const sam = entryResult.success
        ? getLdapAttr(entryResult.data as Record<string, unknown>, 'sAMAccountName')
        : '';
      if (sam) {
        await upsertAdIdentityLink(effectiveEmpId, sam);
      }
    } catch (err) {
      logger.warn({ email: normalizedEmail, err }, 'AD login: identity link backfill after auth failed');
    } finally {
      await adapter.disconnect().catch(() => undefined);
    }
  }

  const portalAccount = await queryOne<{ role: string }>(
    `SELECT role FROM local_accounts
      WHERE emp_id = ? AND active = 1
        AND role IN ('ADMIN','SUPER_ADMIN','APP_CONTRIBUTOR','USER_GROUP_MANAGER','CUSTOM')`,
    [effectiveEmpId],
  );
  const role = portalAccount?.role
    ?? (employee.role && VALID_ROLES.has(employee.role) ? employee.role : 'USER');
  const passwordHash = await hashPassword(password);

  await execute(
    `INSERT INTO local_accounts (emp_id, email, password_hash, role, created_by, active)
     VALUES (?, ?, ?, ?, 'AD_LOGIN', 1)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), active = 1`,
    [effectiveEmpId, normalizedEmail, passwordHash, role],
  );

  const account = await queryOne<AdLoginAccount>(
    `SELECT la.id, la.emp_id, la.email, la.password_hash, la.role, la.active,
            e.ilg_state, e.hrms_status
       FROM local_accounts la
       JOIN employees e ON e.emp_id = la.emp_id
      WHERE la.emp_id = ? AND la.active = 1`,
    [effectiveEmpId],
  );

  if (!account) {
    logger.error({ empId: effectiveEmpId, email: normalizedEmail }, 'AD login: local account upsert failed');
    return { status: 'unavailable', detail: 'local account upsert failed' };
  }

  logger.info({ empId: effectiveEmpId, email: normalizedEmail }, 'AD corporate login succeeded');
  return { status: 'ok', account };
}
