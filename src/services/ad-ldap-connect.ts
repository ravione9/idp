/**
 * Shared AD/LDAP connection helpers — normalize TLS settings and connection modes.
 */

import type { Redis } from 'ioredis';
import { ADAdapter } from '../adapters/ad-adapter.js';
import { config } from '../config.js';
import logger from '../utils/logger.js';
import { parseConnectorBoolean, parseConnectorPort } from '../utils/connector-config.js';

export interface AdLdapModeOverride {
  label: string;
  useSsl?: boolean;
  startTls?: boolean;
  port?: number;
}

export interface AdLdapConnectionParams {
  host: string;
  useSsl: boolean;
  startTls: boolean;
  port: number;
  url: string;
  protocol: 'LDAP' | 'LDAP+StartTLS' | 'LDAPS';
}

export function normalizeAdConnectorTls(cfg: Record<string, unknown>): {
  useSsl: boolean;
  startTls: boolean;
  port: number;
} {
  const useSsl = parseConnectorBoolean(cfg['useSsl'], false);
  const startTls = parseConnectorBoolean(cfg['startTls'], false);
  let port = parseConnectorPort(cfg['port'], useSsl ? 636 : 389);

  if (useSsl) {
    if (port === 389) port = 636;
  } else if (startTls) {
    if (port === 636) port = 389;
  } else if (port === 636) {
    port = 389;
  }

  return { useSsl, startTls, port };
}

/** True when connector is plain LDAP on port 389 — no SSL, TLS, or StartTLS. */
export function isPlainLdapConnector(cfg: Record<string, unknown>): boolean {
  const { useSsl, startTls } = normalizeAdConnectorTls(cfg);
  return !useSsl && !startTls;
}

/** Normalize connector JSON so protocol and port stay consistent after save/load. */
export function normalizeAdConnectorConfig(cfg: Record<string, unknown>): Record<string, unknown> {
  const next = { ...cfg };
  const { useSsl, startTls, port } = normalizeAdConnectorTls(cfg);
  next['useSsl'] = useSsl;
  next['startTls'] = useSsl ? false : startTls;
  next['port'] = String(port);
  return next;
}

export function parseAndNormalizeAdConnectorConfig(
  raw: string | Record<string, unknown>,
): Record<string, unknown> {
  const cfg: Record<string, unknown> = typeof raw === 'string'
    ? JSON.parse(raw || '{}') as Record<string, unknown>
    : (raw ?? {});
  return cfg['host'] ? normalizeAdConnectorConfig(cfg) : cfg;
}

function modeKey(useSsl: boolean, startTls: boolean, port: number): string {
  return `${useSsl}-${startTls}-${port}`;
}

/**
 * Resolved LDAP URL and flags for one connection attempt.
 * Plain LDAP always yields ldap://host:389 with useSsl=false and startTls=false.
 */
export function resolveAdLdapConnectionParams(
  cfg: Record<string, unknown>,
  override: AdLdapModeOverride = { label: 'configured' },
): AdLdapConnectionParams {
  const host = resolveAdConnectorHost(cfg);
  const normalized = normalizeAdConnectorTls(cfg);
  let useSsl = override.useSsl ?? normalized.useSsl;
  let startTls = override.startTls ?? normalized.startTls;
  let port = override.port ?? normalized.port;

  if (useSsl) {
    startTls = false;
    if (port === 389) port = 636;
  } else if (startTls) {
    useSsl = false;
    if (port === 636) port = 389;
  } else {
    useSsl = false;
    startTls = false;
    port = 389;
  }

  const url = `${useSsl ? 'ldaps' : 'ldap'}://${host}:${port}`;
  const protocol = useSsl ? 'LDAPS' : startTls ? 'LDAP+StartTLS' : 'LDAP';
  return { host, useSsl, startTls, port, url, protocol };
}

/**
 * LDAP connection modes for a connector.
 * Plain-LDAP connectors never fall back to StartTLS or LDAPS (no :636 probe).
 */
export function listAdLdapConnectionAttempts(
  cfg: Record<string, unknown>,
  includeProtocolFallbacks = false,
): AdLdapModeOverride[] {
  const normalized = normalizeAdConnectorTls(cfg);
  const modes: AdLdapModeOverride[] = [
    { label: 'configured', ...normalized },
  ];
  if (!includeProtocolFallbacks || isPlainLdapConnector(cfg)) return modes;

  const seen = new Set([modeKey(normalized.useSsl, normalized.startTls, normalized.port)]);

  const add = (mode: AdLdapModeOverride & { useSsl: boolean; startTls: boolean; port: number }) => {
    const key = modeKey(mode.useSsl, mode.startTls, mode.port);
    if (seen.has(key)) return;
    seen.add(key);
    modes.push(mode);
  };

  add({ label: 'starttls', useSsl: false, startTls: true, port: 389 });
  add({ label: 'ldaps', useSsl: true, startTls: false, port: 636 });

  return modes;
}

export function resolveAdConnectorHost(cfg: Record<string, unknown>): string {
  const host = (cfg['host'] as string | undefined)?.trim();
  if (host) return host;
  if (config.ad.url) return new URL(config.ad.url).hostname;
  throw new Error('AD host not configured — set connector host in portal or AD_URL in env/Vault');
}

export function createAdAdapterFromConfig(
  redis: Redis,
  cfg: Record<string, unknown>,
  override: AdLdapModeOverride = { label: 'configured' },
  disabledOu = 'OU=Disabled,',
): ADAdapter {
  const params = resolveAdLdapConnectionParams(cfg, override);
  const bindDn = (cfg['bindDn'] as string | undefined) || config.ad.bindDn;
  const bindPass = (cfg['bindPassword'] as string | undefined) || config.ad.bindPassword;
  const baseDn = (cfg['baseDn'] as string | undefined) || config.ad.baseDn;
  const targetOuRaw = (cfg['targetOu'] as string | undefined)?.trim() ?? '';

  return new ADAdapter(
    redis,
    params.url,
    bindDn,
    bindPass,
    baseDn,
    disabledOu,
    params.startTls,
    targetOuRaw,
  );
}

export function describeAdLdapMode(
  override: AdLdapModeOverride,
  cfg: Record<string, unknown>,
): { url: string; protocol: string } {
  const params = resolveAdLdapConnectionParams(cfg, override);
  return { url: params.url, protocol: params.protocol };
}

/** Connect using the connector's saved protocol only (test, sync, group sync). */
export async function connectAdAdapter(
  redis: Redis,
  cfg: Record<string, unknown>,
): Promise<{ adapter: ADAdapter; mode: AdLdapModeOverride }> {
  const mode = listAdLdapConnectionAttempts(cfg, false)[0]!;
  const params = resolveAdLdapConnectionParams(cfg, mode);
  logger.info(
    { url: params.url, protocol: params.protocol, port: params.port, useSsl: params.useSsl, startTls: params.startTls },
    'AD LDAP connect (saved protocol only)',
  );
  const adapter = createAdAdapterFromConfig(redis, cfg, mode);
  await adapter.resetCircuitBreaker();
  await adapter.connect();
  return { adapter, mode };
}

/**
 * Escalate StartTLS / LDAPS when the saved mode cannot write passwords.
 * Skipped entirely for plain-LDAP connectors (no :636 probe).
 */
export async function connectAdAdapterWithFallback(
  redis: Redis,
  cfg: Record<string, unknown>,
): Promise<{ adapter: ADAdapter; mode: AdLdapModeOverride; errors: string[] }> {
  const errors: string[] = [];
  const allowFallback = !isPlainLdapConnector(cfg);
  for (const mode of listAdLdapConnectionAttempts(cfg, allowFallback)) {
    const adapter = createAdAdapterFromConfig(redis, cfg, mode);
    try {
      await adapter.resetCircuitBreaker();
      await adapter.connect();
      return { adapter, mode, errors };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`[${mode.label}] ${msg}`);
      await adapter.disconnect().catch(() => undefined);
    }
  }
  const suffix = allowFallback
    ? ' (configured, StartTLS :389, LDAPS :636)'
    : ' (plain LDAP :389 only — no TLS/LDAPS fallback)';
  throw new Error(`AD/LDAP connection failed across all modes${suffix}. ${errors.join(' | ')}`);
}
