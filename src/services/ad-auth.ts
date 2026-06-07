/**
 * Active Directory credential verification for portal login.
 * AD-synced employees may not have a local_accounts row until first login or admin reset.
 */

import { ADAdapter } from '../adapters/ad-adapter.js';
import { config } from '../config.js';
import { queryOne, execute } from '../db/connection.js';
import { redis } from '../auth/session-store.js';
import logger from '../utils/logger.js';
import { hashPassword } from './local-admin.js';
import { backfillAdIdentityLinkIfMissing } from './ad-sync.js';

const VALID_ROLES = new Set(['USER', 'MANAGER', 'HRBP', 'ADMIN', 'SUPER_ADMIN']);

function parseConnectorConfig(raw: string | Record<string, unknown>): Record<string, unknown> {
  return typeof raw === 'string'
    ? JSON.parse(raw || '{}') as Record<string, unknown>
    : (raw ?? {});
}

async function loadActiveAdConnectorConfig(): Promise<Record<string, unknown> | null> {
  const row = await queryOne<{ config_json: string | Record<string, unknown> }>(
    `SELECT config_json FROM connectors
      WHERE connector_type IN ('AD', 'LDAP') AND status = 'ACTIVE'
      ORDER BY updated_at DESC LIMIT 1`,
    [],
  );
  if (!row) return null;
  return parseConnectorConfig(row.config_json);
}

function createAdAdapterFromConfig(cfg: Record<string, unknown>): ADAdapter {
  const host = (cfg['host'] as string | undefined)?.trim() || new URL(config.ad.url).hostname;
  const port = Number(cfg['port'] ?? (cfg['useSsl'] ? 636 : 389));
  const useSsl = cfg['useSsl'] !== undefined ? Boolean(cfg['useSsl']) : config.ad.url.startsWith('ldaps');
  const startTls = cfg['startTls'] !== undefined ? Boolean(cfg['startTls']) : false;
  const bindDn = (cfg['bindDn'] as string | undefined) || config.ad.bindDn;
  const bindPass = (cfg['bindPassword'] as string | undefined) || config.ad.bindPassword;
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
       FROM employees WHERE email_corp = ?`,
    [normalizedEmail],
  );
  if (!employee || !['ACTIVE', 'REACTIVATED'].includes(employee.ilg_state)) {
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
  if (!adLink?.external_id) {
    return null;
  }

  const cfg = await loadActiveAdConnectorConfig();
  if (!cfg) {
    return null;
  }

  const adapter = createAdAdapterFromConfig(cfg);
  try {
    await adapter.resetCircuitBreaker();
    await adapter.connect();
    const verified = await adapter.verifyUserCredentials(adLink.external_id, password);
    if (!verified.success) {
      logger.debug(
        { email: normalizedEmail, error: verified.error },
        'AD credential verification failed',
      );
      return null;
    }
  } catch (err) {
    logger.warn({ email: normalizedEmail, err }, 'AD login bind failed');
    return null;
  } finally {
    await adapter.disconnect().catch(() => undefined);
  }

  const role = employee.role && VALID_ROLES.has(employee.role) ? employee.role : 'USER';
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
