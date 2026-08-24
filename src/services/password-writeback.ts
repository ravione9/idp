/**
 * Password Writeback Service
 * --------------------------
 * Writes a new password to all active identity systems (AD, Google) for a given employee.
 * Uses connector config from the connectors table (not legacy .env-only settings).
 */

import { google } from 'googleapis';
import { query, queryOne } from '../db/connection.js';
import { config } from '../config.js';
import { redis } from '../auth/session-store.js';
import { ADAdapter } from '../adapters/ad-adapter.js';
import logger from '../utils/logger.js';
import { getIdentityLinksForEmp } from '../utils/outbox.js';
import { parseConnectorBoolean, parseConnectorPort } from '../utils/connector-config.js';
import { backfillAdIdentityLinkIfMissing } from './ad-sync.js';
import { backfillGoogleIdentityLinkIfMissing } from './google-sync.js';
import {
  buildGoogleJwtAuth,
  parseGoogleServiceAccountKey,
  resolveGoogleImpersonationEmail,
} from './google-directory-config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface WritebackResult {
  system: string;
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  error?: string;
}

// ---------------------------------------------------------------------------
// Connector config helpers
// ---------------------------------------------------------------------------
function parseConnectorConfig(raw: string | Record<string, unknown>): Record<string, unknown> {
  return typeof raw === 'string'
    ? JSON.parse(raw || '{}') as Record<string, unknown>
    : (raw ?? {});
}

async function loadConnectorConfig(
  types: string[],
): Promise<Record<string, unknown> | null> {
  const placeholders = types.map(() => '?').join(',');
  const row = await queryOne<{ config_json: string | Record<string, unknown> }>(
    `SELECT config_json FROM connectors
      WHERE connector_type IN (${placeholders}) AND status IN ('ACTIVE', 'CONNECTED', 'CONFIGURED')
      ORDER BY
        CASE status
          WHEN 'ACTIVE' THEN 0
          WHEN 'CONNECTED' THEN 1
          ELSE 2
        END,
        updated_at DESC
      LIMIT 1`,
    types,
  );
  if (!row) return null;
  return parseConnectorConfig(row.config_json);
}

function createAdAdapterFromConfig(
  cfg: Record<string, unknown>,
  overrides: { useSsl?: boolean; startTls?: boolean; port?: number } = {},
): ADAdapter {
  const useSsl = overrides.useSsl !== undefined
    ? overrides.useSsl
    : parseConnectorBoolean(cfg['useSsl'], config.ad.url.startsWith('ldaps'));
  const startTls = overrides.startTls !== undefined
    ? overrides.startTls
    : parseConnectorBoolean(cfg['startTls'], false);
  const host = (cfg['host'] as string | undefined)?.trim() || new URL(config.ad.url).hostname;
  const port = overrides.port ?? parseConnectorPort(cfg['port'], useSsl ? 636 : 389);
  const bindDn = (cfg['bindDn'] as string | undefined) || config.ad.bindDn;
  const bindPass = (cfg['bindPassword'] as string | undefined) || config.ad.bindPassword;
  const baseDn = (cfg['baseDn'] as string | undefined) || config.ad.baseDn;
  const targetOuRaw = (cfg['targetOu'] as string | undefined)?.trim() ?? '';
  const adUrl = `${useSsl ? 'ldaps' : 'ldap'}://${host}:${port}`;
  return new ADAdapter(redis, adUrl, bindDn, bindPass, baseDn, undefined, startTls, targetOuRaw);
}

async function writebackToGoogle(
  externalId: string,
  newPassword: string,
  cfg: Record<string, unknown>,
): Promise<void> {
  const auth = buildGoogleJwtAuth(cfg, 'BIDIRECTIONAL');
  const directory = google.admin({ version: 'directory_v1', auth });
  await directory.users.update({
    userKey: externalId,
    requestBody: {
      password: newPassword,
      changePasswordAtNextLogin: true,
    },
  });
}

async function writebackToGoogleFallback(
  externalId: string,
  newPassword: string,
): Promise<void> {
  const rawKey = config.google.saKeyJson?.trim();
  if (!rawKey) {
    throw new Error('No active Google connector and GOOGLE_SA_KEY_JSON is not configured');
  }
  const key = parseGoogleServiceAccountKey(rawKey);
  const auth = new google.auth.JWT({
    email:   key['client_email'],
    key:     key['private_key'],
    scopes:  ['https://www.googleapis.com/auth/admin.directory.user'],
    subject: key['client_email'],
  });
  const directory = google.admin({ version: 'directory_v1', auth });
  await directory.users.update({
    userKey: externalId,
    requestBody: { password: newPassword, changePasswordAtNextLogin: true },
  });
}

async function writebackToAD(
  externalId: string,
  newPassword: string,
  cfg: Record<string, unknown> | null,
): Promise<void> {
  if (!cfg) {
    throw new Error('No active Active Directory connector configured');
  }

  // Try three connection modes in order: as-configured → StartTLS on 389 → LDAPS on 636.
  // AD refuses unicodePwd changes over plain LDAP, so we escalate automatically.
  // Each attempt is fully independent (fresh adapter + circuit breaker reset).
  const attempts: Array<{ useSsl?: boolean; startTls?: boolean; port?: number; label: string }> = [
    { label: 'configured' },
    { label: 'starttls', startTls: true },
    { label: 'ldaps', useSsl: true, port: 636 },
  ];

  const errors: string[] = [];

  for (const attempt of attempts) {
    const adapter = createAdAdapterFromConfig(cfg, attempt);
    try {
      await adapter.resetCircuitBreaker();
      await adapter.connect();
      if (!adapter.connectionIsSecure()) {
        errors.push(`[${attempt.label}] plain LDAP cannot write unicodePwd`);
        continue;
      }
      const result = await adapter.setUserPassword(externalId, newPassword);
      if (result.success) {
        logger.info({ externalId, attempt: attempt.label }, 'AD password writeback succeeded');
        return;
      }
      errors.push(`[${attempt.label}] ${result.error ?? 'setUserPassword failed'}`);
    } catch (err) {
      errors.push(`[${attempt.label}] ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await adapter.disconnect().catch(() => undefined);
    }
  }

  throw new Error(
    `AD password writeback failed across all connection modes. ` +
    `Ensure the AD connector is set to LDAPS (port 636) or StartTLS. ` +
    `Details: ${errors.join(' | ')}`,
  );
}

export async function ensureWritebackIdentityLinks(empId: string): Promise<string> {
  const employee = await queryOne<{ email_corp: string | null }>(
    `SELECT email_corp FROM employees WHERE emp_id = ?`,
    [empId],
  );
  const email = employee?.email_corp?.trim();
  if (!email) return empId;

  const adBackfill = await backfillAdIdentityLinkIfMissing(empId, email);
  const effectiveEmpId = adBackfill.empId;
  await backfillGoogleIdentityLinkIfMissing(effectiveEmpId, email);
  return effectiveEmpId;
}

function appendSkippedWhenConnectorActive(
  results: WritebackResult[],
  activeLinks: { system: string }[],
  adCfg: Record<string, unknown> | null,
  googleCfg: Record<string, unknown> | null,
): void {
  const attempted = new Set(results.map((r) => r.system));
  const linked = new Set(activeLinks.map((l) => l.system));

  if (adCfg && !linked.has('AD') && !attempted.has('AD')) {
    results.push({
      system: 'AD',
      status: 'SKIPPED',
      error: 'No AD account found for corporate email — verify AD sync or add an identity link',
    });
  }
  if (googleCfg && !linked.has('GOOGLE') && !attempted.has('GOOGLE')) {
    results.push({
      system: 'GOOGLE',
      status: 'SKIPPED',
      error: 'No Google Workspace user found for corporate email — verify Google sync or add an identity link',
    });
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
export async function writebackPassword(
  empId: string,
  newPassword: string,
  initiatedBy: string,
): Promise<WritebackResult[]> {
  const effectiveEmpId = await ensureWritebackIdentityLinks(empId);

  const adCfg = await loadConnectorConfig(['AD', 'LDAP']);
  const googleCfg = await loadConnectorConfig(['GOOGLE', 'GOOGLE_WORKSPACE']);

  const links = await getIdentityLinksForEmp(effectiveEmpId);
  const activeLinks = links.filter(
    (l) => l.status === 'ACTIVE' && (l.system === 'GOOGLE' || l.system === 'AD'),
  );

  const results: WritebackResult[] = [];

  if (activeLinks.length === 0) {
    logger.info({ empId: effectiveEmpId }, 'Password writeback: no active AD/Google identity links after backfill');
    appendSkippedWhenConnectorActive(results, activeLinks, adCfg, googleCfg);
    return results;
  }

  for (const link of activeLinks) {
    const system = link.system;
    let status: WritebackResult['status'] = 'FAILED';
    let error: string | undefined;

    try {
      if (system === 'GOOGLE') {
        if (googleCfg) {
          resolveGoogleImpersonationEmail(googleCfg, parseGoogleServiceAccountKey(
            String(googleCfg['serviceAccountKey'] ?? config.google.saKeyJson ?? ''),
          ));
          await writebackToGoogle(link.external_id, newPassword, googleCfg);
        } else {
          await writebackToGoogleFallback(link.external_id, newPassword);
        }
        status = 'SUCCESS';
      } else if (system === 'AD') {
        await writebackToAD(link.external_id, newPassword, adCfg);
        status = 'SUCCESS';
      } else {
        status = 'SKIPPED';
        error = 'Unsupported system';
      }
      logger.info({ empId: effectiveEmpId, system, externalId: link.external_id }, 'Password writeback succeeded');
    } catch (err) {
      status = 'FAILED';
      error = err instanceof Error ? err.message : String(err);
      logger.error({ empId: effectiveEmpId, system, externalId: link.external_id, err }, 'Password writeback failed');
    }

    if (system === 'AD' || system === 'GOOGLE') {
      try {
        await query(
          `INSERT INTO password_writeback_log (emp_id, target_system, status, error, initiated_by)
           VALUES (?, ?, ?, ?, ?)`,
          [effectiveEmpId, system, status, error ?? null, initiatedBy],
        );
      } catch (logErr) {
        logger.warn({ empId: effectiveEmpId, system, logErr }, 'Failed to insert password_writeback_log row');
      }
    }

    results.push({ system, status, ...(error ? { error } : {}) });
  }

  appendSkippedWhenConnectorActive(results, activeLinks, adCfg, googleCfg);
  return results;
}
