/**
 * Shared AD/LDAP connection helpers — normalize TLS settings and retry modes.
 */

import type { Redis } from 'ioredis';
import { ADAdapter } from '../adapters/ad-adapter.js';
import { config } from '../config.js';
import { parseConnectorBoolean, parseConnectorPort } from '../utils/connector-config.js';

export interface AdLdapModeOverride {
  label: string;
  useSsl?: boolean;
  startTls?: boolean;
  port?: number;
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
  }

  return { useSsl, startTls, port };
}

/** Normalize connector JSON so protocol and port stay consistent after save/load. */
export function normalizeAdConnectorConfig(cfg: Record<string, unknown>): Record<string, unknown> {
  const next = { ...cfg };
  const { useSsl, startTls, port } = normalizeAdConnectorTls(cfg);
  next['useSsl'] = useSsl;
  next['startTls'] = startTls;
  next['port'] = String(port);
  return next;
}

function modeKey(useSsl: boolean, startTls: boolean, port: number): string {
  return `${useSsl}-${startTls}-${port}`;
}

/** Connection attempts: configured first, then StartTLS :389, LDAPS :636. */
export function listAdLdapConnectionAttempts(cfg: Record<string, unknown>): AdLdapModeOverride[] {
  const normalized = normalizeAdConnectorTls(cfg);
  const modes: AdLdapModeOverride[] = [
    { label: 'configured', ...normalized },
  ];
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
): ADAdapter {
  const host = resolveAdConnectorHost(cfg);
  const normalized = normalizeAdConnectorTls(cfg);
  const useSsl = override.useSsl ?? normalized.useSsl;
  const startTls = override.startTls ?? normalized.startTls;
  const port = override.port ?? normalized.port;
  const bindDn = (cfg['bindDn'] as string | undefined) || config.ad.bindDn;
  const bindPass = (cfg['bindPassword'] as string | undefined) || config.ad.bindPassword;
  const baseDn = (cfg['baseDn'] as string | undefined) || config.ad.baseDn;
  const targetOuRaw = (cfg['targetOu'] as string | undefined)?.trim() ?? '';
  const adUrl = `${useSsl ? 'ldaps' : 'ldap'}://${host}:${port}`;

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

export function describeAdLdapMode(
  override: AdLdapModeOverride,
  cfg: Record<string, unknown>,
): { url: string; protocol: string } {
  const host = resolveAdConnectorHost(cfg);
  const normalized = normalizeAdConnectorTls(cfg);
  const useSsl = override.useSsl ?? normalized.useSsl;
  const startTls = override.startTls ?? normalized.startTls;
  const port = override.port ?? normalized.port;
  const url = `${useSsl ? 'ldaps' : 'ldap'}://${host}:${port}`;
  const protocol = useSsl ? 'LDAPS' : startTls ? 'LDAP+StartTLS' : 'LDAP';
  return { url, protocol };
}

export async function connectAdAdapterWithFallback(
  redis: Redis,
  cfg: Record<string, unknown>,
): Promise<{ adapter: ADAdapter; mode: AdLdapModeOverride; errors: string[] }> {
  const errors: string[] = [];
  for (const mode of listAdLdapConnectionAttempts(cfg)) {
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
  throw new Error(
    `AD/LDAP connection failed across all modes (configured, StartTLS :389, LDAPS :636). ${errors.join(' | ')}`,
  );
}
