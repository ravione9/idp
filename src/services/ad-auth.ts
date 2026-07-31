/**
 * Active Directory credential verification for portal login.
 * AD-synced employees may not have a local_accounts row until first login or admin reset.
 */

import { ADAdapter, getLdapAttr } from '../adapters/ad-adapter.js';
import { config } from '../config.js';
import { queryOne, execute } from '../db/connection.js';
import { redis } from '../auth/session-store.js';
import logger from '../utils/logger.js';
import { parseConnectorBoolean, parseConnectorPort } from '../utils/connector-config.js';
import { hashPassword } from './local-admin.js';
import { backfillAdIdentityLinkIfMissing } from './ad-sync.js';
import { isPortalAccessible } from '../fsm/states.js';

const VALID_ROLES = new Set(['USER', 'MANAGER', 'HRBP', 'ADMIN', 'SUPER_ADMIN']);

type ConnectionAttempt = { useSsl?: boolean; startTls?: boolean; port?: number; label: string };

const CONNECTION_ATTEMPTS: ConnectionAttempt[] = [
  { label: 'configured' },
  { label: 'starttls', startTls: true },
  { label: 'ldaps', useSsl: true, port: 636 },
];

function parseConnectorConfig(raw: string | Record<string, unknown>): Record<string, unknown> {
  return typeof raw === 'string'
    ? JSON.parse(raw || '{}') as Record<string, unknown>
    : (raw ?? {});
}

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
  return parseConnectorConfig(row.config_json);
}

function createAdAdapterFromConfig(
  cfg: Record<string, unknown>,
  overrides: ConnectionAttempt = { label: 'configured' },
): ADAdapter {
  const useSsl = overrides.useSsl !== undefined
    ? overrides.useSsl
    : parseConnectorBoolean(cfg['useSsl'], config.ad.url.startsWith('ldaps'));
  const startTls = overrides.startTls !== undefined
    ? overrides.startTls
    : parseConnectorBoolean(cfg['startTls'], false);
  const host = (cfg['host'] as string | undefined)?.trim()
    || (config.ad.url ? new URL(config.ad.url).hostname : '');
  if (!host) {
    throw new Error('AD host not configured — set connector host in portal or AD_URL in env/Vault');
  }
  const port = overrides.port ?? parseConnectorPort(cfg['port'], useSsl ? 636 : 389);
  const bindDn = (cfg['bindDn'] as string | undefined) || config.ad.bindDn;
  const bindPass = resolveBindPassword(cfg);
  const baseDn = (cfg['baseDn'] as string | undefined) || config.ad.baseDn;
  const targetOuRaw = (cfg['targetOu'] as string | undefined)?.trim() ?? '';
  const adUrl = `${useSsl ? 'ldaps' : 'ldap'}://${host}:${port}`;
  return new ADAdapter(redis, adUrl, bindDn, bindPass, baseDn, undefined, startTls, targetOuRaw);
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

  for (const attempt of CONNECTION_ATTEMPTS) {
    const adapter = createAdAdapterFromConfig(cfg, attempt);
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

/**
 * Verify corporate email + password against Active Directory and provision a local_accounts
 * row so MFA and future local-hash logins work.
 */
export async function authenticateAdCorporateUser(
  email: string,
  password: string,
): Promise<AdLoginAccount | null> {
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
    return null;
  }
  if (!isPortalAccessible(employee.ilg_state)) {
    logger.info({ email: normalizedEmail, ilg_state: employee.ilg_state }, 'AD login: employee not portal-accessible');
    return null;
  }

  const cfg = await loadActiveAdConnectorConfig();
  if (!cfg) {
    logger.warn({ email: normalizedEmail }, 'AD login: no AD/LDAP connector config found');
    return null;
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

  const verified = await verifyAdLoginPassword(
    cfg,
    normalizedEmail,
    password,
    adLink?.external_id,
  );
  if (!verified.ok) {
    logger.warn(
      { email: normalizedEmail, empId: effectiveEmpId, error: verified.error },
      'AD corporate login failed',
    );
    return null;
  }

  if (!adLink?.external_id) {
    const adapter = createAdAdapterFromConfig(cfg);
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
    return null;
  }

  logger.info({ empId: effectiveEmpId, email: normalizedEmail }, 'AD corporate login succeeded');
  return account;
}
