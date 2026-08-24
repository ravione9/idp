/**
 * Directory connector connectivity tests + health status lifecycle.
 *
 * Status model:
 *   CONFIGURED — saved, not yet proven reachable
 *   CONNECTED  — last health check / test succeeded (shows as Active in UI)
 *   ERROR      — last health check / test failed
 *   DISABLED   — admin disabled
 *   ACTIVE     — legacy; treated like CONNECTED for sync eligibility
 */
import { google } from 'googleapis';
import { execute, query, queryOne } from '../db/connection.js';
import logger from '../utils/logger.js';
import { withSchedLock } from '../utils/sched-lock.js';
import { parseConnectorPort } from '../utils/connector-config.js';
import {
  connectAdAdapterWithFallback,
  describeAdLdapMode,
  listAdLdapConnectionAttempts,
  normalizeAdConnectorTls,
} from './ad-ldap-connect.js';
import {
  buildGoogleJwtAuth,
  formatGoogleAuthError,
  listScopedGoogleUsers,
  normalizeConnectorDirection,
  resolveGoogleSyncScope,
} from './google-directory-config.js';
import {
  AGENT_HEARTBEAT_TTL_MS,
  isAgentRecentlyConnected,
} from './ad-agent-sync.js';
import { parseGoogleHostedDomains } from '../auth/google-domains.js';

export type ConnectorHealthStatus = 'CONFIGURED' | 'CONNECTED' | 'ERROR' | 'DISABLED' | 'ACTIVE';

export interface ConnectorTestResult {
  success: boolean;
  statusCode: number;
  code?: string;
  message: string;
  warnings?: string[];
  info?: string[];
  ouSuggestions?: string[];
  detail?: string;
  connectorStatus: ConnectorHealthStatus;
}

const HEALTH_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
let healthTimer: ReturnType<typeof setInterval> | null = null;

export function isConnectorSyncEligible(status: string | null | undefined): boolean {
  const s = (status || '').toUpperCase();
  return s === 'CONNECTED' || s === 'ACTIVE';
}

export async function markConnectorHealth(
  connectorId: string,
  ok: boolean,
  message: string | null,
): Promise<void> {
  const status = ok ? 'CONNECTED' : 'ERROR';
  await execute(
    `UPDATE connectors SET
       status = ?,
       last_error = ?,
       last_health_check_at = UTC_TIMESTAMP(),
       last_health_ok = ?,
       updated_at = UTC_TIMESTAMP()
     WHERE id = ? AND status != 'DISABLED'`,
    [status, ok ? null : (message || 'Connection check failed').slice(0, 2000), ok ? 1 : 0, connectorId],
  );
}

export async function runConnectorConnectivityTest(connectorId: string): Promise<ConnectorTestResult> {
  const row = await queryOne<{ connector_type: string; config_json: string | Record<string, unknown>; status: string; direction: string }>(
    `SELECT connector_type, config_json, status, direction FROM connectors WHERE id = ?`,
    [connectorId],
  );
  if (!row) {
    return {
      success: false,
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Connector not found',
      connectorStatus: 'ERROR',
    };
  }
  if (row.status === 'DISABLED') {
    return {
      success: false,
      statusCode: 409,
      code: 'DISABLED',
      message: 'Connector is disabled',
      connectorStatus: 'DISABLED',
    };
  }

  const type = row.connector_type;
  const cfg: Record<string, unknown> = typeof row.config_json === 'string'
    ? JSON.parse(row.config_json || '{}') as Record<string, unknown>
    : (row.config_json ?? {});

  try {
    if (type === 'AD' || type === 'LDAP') {
      const result = await testAdLdap(cfg);
      if (result.success) {
        await markConnectorHealth(connectorId, true, result.message);
        return { ...result, connectorStatus: 'CONNECTED' };
      }
      await markConnectorHealth(connectorId, false, result.message);
      return { ...result, connectorStatus: 'ERROR' };
    }

    if (type === 'AD_AGENT') {
      const result = await testAdAgent(connectorId, cfg);
      if (result.success) {
        await markConnectorHealth(connectorId, true, result.message);
        return { ...result, connectorStatus: 'CONNECTED' };
      }
      if (result.code === 'WAITING_FOR_AGENT') {
        return { ...result, connectorStatus: 'CONFIGURED' };
      }
      await markConnectorHealth(connectorId, false, result.message);
      return { ...result, connectorStatus: 'ERROR' };
    }

    if (type === 'GOOGLE' || type === 'GOOGLE_WORKSPACE') {
      const direction = normalizeConnectorDirection(row.direction);
      const result = await testGoogle(cfg, direction);
      if (result.success) {
        await markConnectorHealth(connectorId, true, result.message);
        return { ...result, connectorStatus: 'CONNECTED' };
      }
      await markConnectorHealth(connectorId, false, result.message);
      return { ...result, connectorStatus: 'ERROR' };
    }

    // Unknown types: configuration present counts as connected for now
    await markConnectorHealth(connectorId, true, `${type} configuration saved`);
    return {
      success: true,
      statusCode: 200,
      message: `Connector "${type}" configuration saved. Full test on next sync.`,
      connectorStatus: 'CONNECTED',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ connectorId, err }, 'Connector connectivity test unexpected error');
    await markConnectorHealth(connectorId, false, msg);
    return {
      success: false,
      statusCode: 422,
      code: 'UNEXPECTED_ERROR',
      message: msg,
      connectorStatus: 'ERROR',
    };
  }
}

async function testAdAgent(connectorId: string, cfg: Record<string, unknown>): Promise<Omit<ConnectorTestResult, 'connectorStatus'>> {
  if (!String(cfg['agentTokenHash'] ?? '').trim()) {
    return {
      success: false,
      statusCode: 422,
      code: 'MISSING_AGENT_TOKEN',
      message: 'Agent token not configured — re-save the connector or regenerate the token.',
    };
  }
  if (!String(cfg['idpUrl'] ?? '').trim()) {
    return {
      success: false,
      statusCode: 422,
      code: 'MISSING_IDP_URL',
      message: 'Missing idpUrl — set the IdP HTTPS URL (port 443) in connector settings.',
    };
  }

  const row = await queryOne<{ last_health_check_at: Date | string | null; last_health_ok: number | null }>(
    `SELECT last_health_check_at, last_health_ok FROM connectors WHERE id = ?`,
    [connectorId],
  );

  if (row && isAgentRecentlyConnected(row.last_health_check_at) && row.last_health_ok === 1) {
    return {
      success: true,
      statusCode: 200,
      message: `AD Agent connected (heartbeat within ${Math.round(AGENT_HEARTBEAT_TTL_MS / 60_000)} minutes).`,
    };
  }

  return {
    success: false,
    statusCode: 202,
    code: 'WAITING_FOR_AGENT',
    message:
      'Waiting for on-prem AD Agent — install and start lilg-ad-connector.exe on a domain server. ' +
      'The agent connects outbound to IdP on HTTPS :443 and sends heartbeats.',
  };
}

async function testAdLdap(cfg: Record<string, unknown>): Promise<Omit<ConnectorTestResult, 'connectorStatus'>> {
  const host = (cfg['host'] as string | undefined)?.trim();
  const bindDn = (cfg['bindDn'] as string | undefined)?.trim();
  const bindPass = cfg['bindPassword'] as string | undefined;

  const missing: string[] = [];
  if (!host) missing.push('host');
  if (!bindDn) missing.push('bindDn');
  if (!bindPass) missing.push('bindPassword');
  if (missing.length) {
    return {
      success: false,
      statusCode: 422,
      code: 'MISSING_CONFIG',
      message: `Missing required AD/LDAP config field(s): ${missing.join(', ')}. Save the connector with all fields filled in before testing.`,
    };
  }
  if (bindPass === '••••••••') {
    return {
      success: false,
      statusCode: 422,
      code: 'REDACTED_PASSWORD',
      message: 'The bindPassword appears to still be the redaction placeholder. Re-enter the real password and save the connector before testing.',
    };
  }

  const { redis: sessionRedis } = await import('../auth/session-store.js');
  const baseDn = (cfg['baseDn'] as string | undefined)?.trim();
  const targetOuRaw = (cfg['targetOu'] as string | undefined)?.trim() ?? '';
  const warnings: string[] = [];
  const infos: string[] = [];
  let suggestions: string[] = [];

  try {
    const { adapter, mode, errors: attemptErrors } = await connectAdAdapterWithFallback(sessionRedis, cfg);
    const { url, protocol } = describeAdLdapMode(mode, cfg);
    const normalized = normalizeAdConnectorTls(cfg);

    if (mode.label !== 'configured') {
      infos.push(
        `Connected using ${protocol} (${mode.label} fallback)` +
        (attemptErrors.length ? ` — prior attempt(s): ${attemptErrors.join('; ')}` : ''),
      );
    } else if (
      normalized.startTls && normalized.port === 389
      && parseConnectorPort(cfg['port'], 389) === 636
    ) {
      infos.push('Port corrected from 636 to 389 for LDAP+StartTLS.');
    }

    if (baseDn) {
      try {
        const { resolveAdDirectoryConfig } = await import('../adapters/ad-adapter.js');
        const dir = resolveAdDirectoryConfig(baseDn, targetOuRaw);
        if (dir.inferredProvisionOu) {
          infos.push(
            `New User OU inferred as ${dir.provisionOuRdn} from Base DN. Recommended: Base DN = ${dir.domainRoot}, New User OU = ${dir.provisionOuRdn}`,
          );
        }
      } catch (err) {
        warnings.push(err instanceof Error ? err.message : String(err));
      }
    }

    if (!normalized.useSsl && !normalized.startTls && mode.label === 'ldap') {
      warnings.push('Protocol is plain LDAP — user provisioning requires LDAPS or LDAP+StartTLS');
    }

    if (baseDn) {
      try {
        const { resolveAdSyncScope, describeAdSyncScope } = await import('./ad-directory-config.js');
        const scope = resolveAdSyncScope(cfg);
        const listed = await adapter.listDirectoryUsers(scope);
        if (listed.success) {
          infos.push(describeAdSyncScope(scope, listed.data.length));
        } else if (listed.error) {
          warnings.push(`User scope preview failed: ${listed.error}`);
        }
      } catch (err) {
        warnings.push(err instanceof Error ? err.message : String(err));
      }
    }

    await adapter.disconnect();
    const detail = [...infos, ...warnings].join('; ');
    const msg = detail
      ? `${protocol} bind succeeded (${url})${warnings.length ? ', but' : ''}: ${detail}`
      : `${protocol} bind succeeded — connected to ${url} as ${bindDn}`;

    return {
      success: warnings.length === 0,
      statusCode: warnings.length ? 422 : 200,
      message: msg,
      ...(warnings.length ? { warnings } : {}),
      ...(infos.length ? { info: infos } : {}),
      ...(suggestions.length ? { ouSuggestions: suggestions } : {}),
    };
  } catch (ldapErr) {
    const attempts = listAdLdapConnectionAttempts(cfg);
    const raw = ldapErr instanceof Error ? ldapErr.message : String(ldapErr);
    const code = (ldapErr as Record<string, unknown>)['code'];
    let friendly: string;
    if (typeof code === 'number' && code === 49) {
      friendly = `Invalid credentials (LDAP error 49) — check bindDn and bindPassword. DN used: ${bindDn}`;
    } else if ((typeof code === 'number' && code === 8) || /Strong(er)? authentication required/i.test(raw)) {
      friendly = 'Strong authentication required (LDAP error 8) — use LDAP+StartTLS on port 389 or LDAPS on port 636.';
    } else if (typeof code === 'number' && code === 32) {
      friendly = `No Such Object (LDAP error 32) — bindDn not found. DN used: ${bindDn}`;
    } else if (raw.includes('ECONNREFUSED')) {
      friendly = `Connection refused — IdP cannot reach ${host} on port 389/636. Open firewall from IdP to the domain controller, or use the on-prem AD Agent connector.`;
    } else if (raw.includes('ETIMEDOUT') || raw.includes('connectTimeout')) {
      friendly = `Connection timed out reaching ${host} on port 389/636 — check network/firewall routes from IdP to AD.`;
    } else if (raw.includes('ENOTFOUND') || raw.includes('getaddrinfo')) {
      friendly = `DNS resolution failed for host "${host}".`;
    } else if (attempts.length > 1) {
      friendly = raw;
    } else {
      friendly = `LDAP error (${typeof code !== 'undefined' ? `code ${code}` : 'unknown'}): ${raw}`;
    }
    return {
      success: false,
      statusCode: 422,
      code: `LDAP_${code ?? 'ERROR'}`,
      message: friendly,
      detail: raw,
    };
  }
}

async function testGoogle(
  cfg: Record<string, unknown>,
  direction: ReturnType<typeof normalizeConnectorDirection>,
): Promise<Omit<ConnectorTestResult, 'connectorStatus'>> {
  const domains = parseGoogleHostedDomains(cfg['customerDomains'] ?? cfg['customerDomain']);
  const missing: string[] = [];
  if (!domains.length) missing.push('customerDomain');
  if (!String(cfg['adminEmail'] ?? '').trim()) missing.push('adminEmail');
  if (!String(cfg['serviceAccountKey'] ?? '').trim()) missing.push('serviceAccountKey');
  if (missing.length) {
    return {
      success: false,
      statusCode: 422,
      code: 'MISSING_CONFIG',
      message: `Missing required Google Workspace config field(s): ${missing.join(', ')}`,
    };
  }

  try {
    const auth = buildGoogleJwtAuth(cfg, direction);
    const directory = google.admin({ version: 'directory_v1', auth });
    await directory.users.list({ customer: 'my_customer', maxResults: 1 });

    const scope = resolveGoogleSyncScope(cfg);
    const scopedUsers = await listScopedGoogleUsers(directory, scope);
    const scopeParts: string[] = [];
    if (scope.orgUnits.length) scopeParts.push(`${scope.orgUnits.length} OU(s)`);
    if (scope.groups.length) scopeParts.push(`${scope.groups.length} group(s)`);
    if (scope.users.length) scopeParts.push(`${scope.users.length} explicit user(s)`);
    const scopeLabel = scopeParts.length ? scopeParts.join(', ') : 'entire directory';
    const domainLabel = scope.customerDomains.join(', ');
    const notFoundHint = scopedUsers.notFoundEmails.length
      ? ` Not found in Google: ${scopedUsers.notFoundEmails.join(', ')}.`
      : '';

    return {
      success: true,
      statusCode: 200,
      message: `Connected to Google Workspace (${domainLabel}). Sync scope: ${scopeLabel} — ${scopedUsers.users.length} user(s) matched.${notFoundHint}`,
    };
  } catch (googleErr) {
    return {
      success: false,
      statusCode: 422,
      code: 'GOOGLE_AUTH_FAILED',
      message: formatGoogleAuthError(googleErr, cfg, direction),
      detail: googleErr instanceof Error ? googleErr.message : String(googleErr),
    };
  }
}

async function connectorHealthTick(): Promise<void> {
  try {
    const rows = await query<{ id: string; name: string; status: string }>(
      `SELECT id, name, status FROM connectors
        WHERE status IN ('CONFIGURED', 'CONNECTED', 'ACTIVE', 'ERROR')
        ORDER BY updated_at ASC
        LIMIT 20`,
      [],
    );
    for (const row of rows) {
      try {
        const result = await runConnectorConnectivityTest(row.id);
        logger.info(
          { connectorId: row.id, name: row.name, ok: result.success, status: result.connectorStatus },
          'Connector health check',
        );
      } catch (err) {
        logger.warn({ connectorId: row.id, err }, 'Connector health check failed');
      }
    }
  } catch (err) {
    logger.error({ err }, 'Connector health scheduler tick failed');
  }
}

/** Periodic re-test of non-disabled connectors so Active/Error stays honest. */
export function startConnectorHealthScheduler(): void {
  if (healthTimer) return;
  const lockTtlMs = Math.floor(HEALTH_INTERVAL_MS * 0.9);
  const lockedTick = () => withSchedLock('connector-health', lockTtlMs, connectorHealthTick);

  // First run shortly after boot, then every 15 minutes
  setTimeout(() => { void lockedTick(); }, 60_000).unref();
  healthTimer = setInterval(() => { void lockedTick(); }, HEALTH_INTERVAL_MS);
  healthTimer.unref();
  logger.info({ intervalMs: HEALTH_INTERVAL_MS }, 'Connector health scheduler started');
}
