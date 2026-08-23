/**
 * Build directory adapters from connector DB config (Directory Sync UI).
 * Used by outbox worker, password writeback, and immediate portal→AD disable.
 */

import { queryOne, execute } from '../db/connection.js';
import { redis } from '../auth/session-store.js';
import { config } from '../config.js';
import { ADAdapter } from '../adapters/ad-adapter.js';
import type { BaseAdapter } from '../adapters/base-adapter.js';
import { parseConnectorBoolean, parseConnectorPort } from '../utils/connector-config.js';
import { getIdentityLinksForEmp } from '../utils/outbox.js';
import logger from '../utils/logger.js';

function parseConnectorConfig(raw: string | Record<string, unknown>): Record<string, unknown> {
  return typeof raw === 'string'
    ? JSON.parse(raw || '{}') as Record<string, unknown>
    : (raw ?? {});
}

export async function loadActiveConnectorConfig(types: string[]): Promise<Record<string, unknown> | null> {
  const placeholders = types.map(() => '?').join(',');
  const row = await queryOne<{ config_json: string | Record<string, unknown> }>(
    `SELECT config_json FROM connectors
      WHERE connector_type IN (${placeholders})
        AND status IN ('ACTIVE', 'CONNECTED', 'CONFIGURED')
      ORDER BY
        CASE status
          WHEN 'ACTIVE' THEN 0
          WHEN 'CONNECTED' THEN 1
          ELSE 2
        END,
        last_sync_at DESC,
        updated_at DESC
      LIMIT 1`,
    types,
  );
  if (!row) return null;
  return parseConnectorConfig(row.config_json);
}

export function createAdAdapterFromConnectorConfig(cfg: Record<string, unknown>): ADAdapter {
  const host = (cfg['host'] as string | undefined)?.trim() || new URL(config.ad.url).hostname;
  const useSsl = parseConnectorBoolean(cfg['useSsl'], config.ad.url.startsWith('ldaps'));
  const startTls = parseConnectorBoolean(cfg['startTls'], false);
  const port = parseConnectorPort(cfg['port'], useSsl ? 636 : 389);
  const bindDn = (cfg['bindDn'] as string | undefined) || config.ad.bindDn;
  const bindPass = (cfg['bindPassword'] as string | undefined) || config.ad.bindPassword;
  const baseDn = (cfg['baseDn'] as string | undefined) || config.ad.baseDn;
  const targetOuRaw = (cfg['targetOu'] as string | undefined)?.trim() ?? '';
  const disabledOu = (cfg['disabledOu'] as string | undefined)?.trim() || 'OU=Disabled,';
  const adUrl = `${useSsl ? 'ldaps' : 'ldap'}://${host}:${port}`;

  return new ADAdapter(redis, adUrl, bindDn, bindPass, baseDn, disabledOu, startTls, targetOuRaw);
}

const connectorAdapterCache = new Map<string, BaseAdapter>();

/** Resolve adapter for outbox/lifecycle — env registry first, then active connector config. */
export async function resolveDirectoryAdapter(
  system: string,
  envRegistry: Record<string, BaseAdapter>,
): Promise<BaseAdapter | null> {
  const key = system.toUpperCase();
  if (envRegistry[key]) return envRegistry[key];

  const cached = connectorAdapterCache.get(key);
  if (cached) return cached;

  if (key === 'AD' || key === 'LDAP') {
    const cfg = await loadActiveConnectorConfig(['AD', 'LDAP']);
    if (!cfg) return null;
    const adapter = createAdAdapterFromConnectorConfig(cfg);
    connectorAdapterCache.set(key, adapter);
    connectorAdapterCache.set('AD', adapter);
    connectorAdapterCache.set('LDAP', adapter);
    return adapter;
  }

  return null;
}

/** Disable AD account immediately when portal admin suspends (outbox remains backup). */
export async function propagatePortalDisableToAd(empId: string): Promise<void> {
  const links = await getIdentityLinksForEmp(empId);
  const adLink = links.find((l) => l.system === 'AD' && l.status === 'ACTIVE');
  if (!adLink?.external_id) return;

  const cfg = await loadActiveConnectorConfig(['AD', 'LDAP']);
  if (!cfg) {
    logger.warn({ empId }, 'Portal disable: no AD connector config — outbox only');
    return;
  }

  const adapter = createAdAdapterFromConnectorConfig(cfg);
  try {
    await adapter.resetCircuitBreaker();
    await adapter.connect();
    const result = await adapter.disable(adLink.external_id);
    if (result.success) {
      await execute(
        `UPDATE identity_links SET status = 'DISABLED', last_synced_at = UTC_TIMESTAMP()
          WHERE id = ?`,
        [adLink.id],
      );
      logger.info({ empId, sam: adLink.external_id }, 'Portal disable: AD account disabled immediately');
    } else {
      logger.warn({ empId, error: result.error }, 'Portal disable: immediate AD disable failed — outbox will retry');
    }
  } catch (err) {
    logger.warn({ empId, err }, 'Portal disable: immediate AD disable error — outbox will retry');
  } finally {
    await adapter.disconnect().catch(() => undefined);
  }
}

/** Re-enable AD when portal admin unsuspends. */
export async function propagatePortalEnableToAd(empId: string): Promise<void> {
  const links = await getIdentityLinksForEmp(empId);
  const adLink = links.find((l) => l.system === 'AD' && l.status === 'DISABLED');
  if (!adLink?.external_id) return;

  const cfg = await loadActiveConnectorConfig(['AD', 'LDAP']);
  if (!cfg) return;

  const adapter = createAdAdapterFromConnectorConfig(cfg);
  try {
    await adapter.resetCircuitBreaker();
    await adapter.connect();
    const result = await adapter.enable(adLink.external_id);
    if (result.success) {
      await execute(
        `UPDATE identity_links SET status = 'ACTIVE', last_synced_at = UTC_TIMESTAMP()
          WHERE id = ?`,
        [adLink.id],
      );
      logger.info({ empId, sam: adLink.external_id }, 'Portal unsuspend: AD account re-enabled');
    }
  } catch (err) {
    logger.warn({ empId, err }, 'Portal unsuspend: immediate AD enable failed — outbox will retry');
  } finally {
    await adapter.disconnect().catch(() => undefined);
  }
}
