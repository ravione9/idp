/**
 * Entitlement Harvest (OIG-style)
 * --------------------------------
 * Pulls requestable entitlements (groups/roles) from connected directories
 * into the IGA `entitlements` catalog so users can request them.
 *
 * Supported connectors: AD / LDAP, GOOGLE / GOOGLE_WORKSPACE.
 */

import { v4 as uuidv4 } from 'uuid';
import { google } from 'googleapis';
import { query, queryOne, execute } from '../db/connection.js';
import { ADAdapter } from '../adapters/ad-adapter.js';
import { redis } from '../auth/session-store.js';
import { config } from '../config.js';
import { parseConnectorBoolean, parseConnectorPort } from '../utils/connector-config.js';
import { buildGoogleJwtAuth, normalizeConnectorDirection, resolveGoogleSyncScope, isGoogleGroupSyncAll } from './google-directory-config.js';
import { isConnectorSyncEligible } from './connector-health.js';
import logger from '../utils/logger.js';

export interface HarvestResult {
  connectorId: string;
  connectorName: string;
  runId: string;
  harvested: number;
  updated: number;
  deactivated: number;
  errors: string[];
}

interface ConnectorRow {
  id: string;
  name: string;
  slug: string;
  connector_type: string;
  status: string;
  direction: string;
  config_json: string | Record<string, unknown>;
}

function parseCfg(raw: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw || '{}') as Record<string, unknown>; } catch { return {}; }
  }
  return raw ?? {};
}

function slugify(input: string, prefix: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return `${prefix}-${base || uuidv4().slice(0, 8)}`;
}

function createAdAdapter(cfg: Record<string, unknown>): ADAdapter {
  const host = (cfg['host'] as string | undefined)?.trim() || new URL(config.ad.url).hostname;
  const useSsl = parseConnectorBoolean(cfg['useSsl'], config.ad.url.startsWith('ldaps'));
  const startTls = parseConnectorBoolean(cfg['startTls'], false);
  const port = parseConnectorPort(cfg['port'], useSsl ? 636 : 389);
  const bindDn = (cfg['bindDn'] as string | undefined) || config.ad.bindDn;
  const bindPass = (cfg['bindPassword'] as string | undefined) || config.ad.bindPassword;
  const baseDn = (cfg['baseDn'] as string | undefined) || config.ad.baseDn;
  const targetOuRaw = (cfg['targetOu'] as string | undefined)?.trim() ?? '';
  const adUrl = `${useSsl ? 'ldaps' : 'ldap'}://${host}:${port}`;
  return new ADAdapter(redis, adUrl, bindDn, bindPass, baseDn, undefined, startTls, targetOuRaw);
}

interface HarvestedEnt {
  externalId: string;
  name: string;
  slug: string;
  description?: string;
  metadata: Record<string, unknown>;
}

async function upsertEntitlement(
  connectorId: string,
  ent: HarvestedEnt,
): Promise<'created' | 'updated'> {
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM entitlements
      WHERE connector_id = ? AND external_id = ?`,
    [connectorId, ent.externalId],
  );
  if (existing) {
    await execute(
      `UPDATE entitlements SET
         name = ?, slug = ?, description = ?, type = 'GROUP',
         metadata = ?, active = 1, requestable = 0, last_harvested_at = UTC_TIMESTAMP()
       WHERE id = ?`,
      [ent.name, ent.slug, ent.description ?? null, JSON.stringify(ent.metadata), existing.id],
    );
    return 'updated';
  }

  // Slug collision under same connector — suffix
  let slug = ent.slug;
  const clash = await queryOne<{ id: string }>(
    `SELECT id FROM entitlements WHERE connector_id = ? AND slug = ? AND (app_id IS NULL)`,
    [connectorId, slug],
  );
  if (clash) slug = `${slug}-${uuidv4().slice(0, 6)}`;

  // Directory groups are inventory / fulfill targets — not Request Access catalog items
  await execute(
    `INSERT INTO entitlements
       (id, app_id, connector_id, name, slug, type, description, risk_score,
        is_birthright, external_id, metadata, active, requestable, last_harvested_at)
     VALUES (?, NULL, ?, ?, ?, 'GROUP', ?, 0, 0, ?, ?, 1, 0, UTC_TIMESTAMP())`,
    [
      uuidv4(),
      connectorId,
      ent.name,
      slug,
      ent.description ?? null,
      ent.externalId,
      JSON.stringify(ent.metadata),
    ],
  );
  return 'created';
}

async function harvestAd(_connectorId: string, cfg: Record<string, unknown>): Promise<{
  items: HarvestedEnt[];
  errors: string[];
}> {
  const errors: string[] = [];
  const adapter = createAdAdapter(cfg);
  const items: HarvestedEnt[] = [];
  try {
    await adapter.connect();
    const listed = await adapter.listDirectoryGroups();
    if (!listed.success) {
      errors.push(listed.error ?? 'Failed to list AD groups');
      return { items, errors };
    }
    for (const g of listed.data ?? []) {
      items.push({
        externalId: g.dn,
        name: g.name,
        slug: slugify(g.sam || g.name, 'ad'),
        description: `AD security group (${g.sam || g.name})`,
        metadata: {
          source: 'AD',
          dn: g.dn,
          sAMAccountName: g.sam ?? null,
          kind: 'GROUP',
        },
      });
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  } finally {
    try { await adapter.disconnect(); } catch { /* ignore */ }
  }
  return { items, errors };
}

async function harvestGoogle(
  _connectorId: string,
  cfg: Record<string, unknown>,
  direction: ReturnType<typeof normalizeConnectorDirection>,
): Promise<{
  items: HarvestedEnt[];
  errors: string[];
}> {
  const errors: string[] = [];
  const items: HarvestedEnt[] = [];
  try {
    const auth = buildGoogleJwtAuth(cfg, direction);
    const directory = google.admin({ version: 'directory_v1', auth });
    const scope = resolveGoogleSyncScope(cfg);

    let emails: string[] = [];
    if (!isGoogleGroupSyncAll(cfg) && scope.groups.length > 0) {
      emails = scope.groups.map((e) => e.toLowerCase());
    } else {
      let pageToken: string | undefined;
      do {
        const res = await directory.groups.list({
          customer: 'my_customer',
          maxResults: 200,
          ...(pageToken ? { pageToken } : {}),
        });
        for (const g of res.data.groups ?? []) {
          const email = (g.email ?? '').trim().toLowerCase();
          if (email) emails.push(email);
          if (emails.length >= 200) break;
        }
        pageToken = emails.length >= 200 ? undefined : (res.data.nextPageToken ?? undefined);
      } while (pageToken);
    }

    for (const email of emails) {
      try {
        const gRes = await directory.groups.get({ groupKey: email });
        const g = gRes.data;
        const externalId = (g.email ?? email).toLowerCase();
        const name = g.name ?? externalId;
        items.push({
          externalId,
          name,
          slug: slugify(externalId.split('@')[0] || name, 'gw'),
          description: g.description || `Google Workspace group (${externalId})`,
          metadata: {
            source: 'GOOGLE',
            email: externalId,
            googleGroupId: g.id ?? null,
            kind: 'GROUP',
          },
        });
      } catch (err) {
        errors.push(`${email}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  return { items, errors };
}

/**
 * Harvest entitlements from a connector into the IGA catalog.
 * Soft-deactivates previously harvested entitlements that disappeared from the target.
 */
export async function harvestConnectorEntitlements(
  connectorId: string,
  triggeredBy: string,
): Promise<HarvestResult> {
  const connector = await queryOne<ConnectorRow>(
    `SELECT id, name, slug, connector_type, status, direction, config_json FROM connectors WHERE id = ?`,
    [connectorId],
  );
  if (!connector) throw new Error('Connector not found');
  if (!isConnectorSyncEligible(connector.status)) {
    throw new Error('Connector is not connected — run Test Connection successfully first');
  }

  const runId = uuidv4();
  await execute(
    `INSERT INTO connector_runs
       (id, connector_id, run_type, status, started_at, items_processed, items_succeeded, items_failed, payload)
     VALUES (?, ?, 'ENTITLEMENT_HARVEST', 'RUNNING', UTC_TIMESTAMP(), 0, 0, 0, ?)`,
    [runId, connectorId, JSON.stringify({ triggeredBy })],
  );

  const type = (connector.connector_type || '').toUpperCase();
  const cfg = parseCfg(connector.config_json);
  let harvested = 0;
  let updated = 0;
  let errors: string[] = [];
  const seenExternal = new Set<string>();

  try {
    let pack: { items: HarvestedEnt[]; errors: string[] };
    if (type === 'AD' || type === 'LDAP' || connector.slug === 'active-directory') {
      pack = await harvestAd(connectorId, cfg);
    } else if (
      type === 'GOOGLE'
      || type === 'GOOGLE_WORKSPACE'
      || connector.slug === 'google-workspace'
    ) {
      pack = await harvestGoogle(connectorId, cfg, normalizeConnectorDirection(connector.direction));
    } else {
      throw new Error(
        `Entitlement harvest not supported for connector type: ${connector.connector_type}. `
        + 'Supported: AD, LDAP, GOOGLE / GOOGLE_WORKSPACE.',
      );
    }
    errors = pack.errors;

    for (const item of pack.items) {
      seenExternal.add(item.externalId);
      try {
        const op = await upsertEntitlement(connectorId, item);
        if (op === 'created') harvested++;
        else updated++;
      } catch (err) {
        errors.push(`${item.externalId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Soft-deactivate harvested entitlements no longer present on target
    const prior = await query<{ id: string; external_id: string }>(
      `SELECT id, external_id FROM entitlements
        WHERE connector_id = ? AND external_id IS NOT NULL AND active = 1`,
      [connectorId],
    );
    let deactivated = 0;
    for (const row of prior) {
      if (!row.external_id || seenExternal.has(row.external_id)) continue;
      // Only deactivate ones that look harvested (have metadata.source)
      const metaRow = await queryOne<{ metadata: unknown }>(
        `SELECT metadata FROM entitlements WHERE id = ?`,
        [row.id],
      );
      let meta: Record<string, unknown> = {};
      try {
        meta = typeof metaRow?.metadata === 'string'
          ? JSON.parse(metaRow.metadata) as Record<string, unknown>
          : (metaRow?.metadata as Record<string, unknown>) ?? {};
      } catch { /* ignore */ }
      if (meta['source'] !== 'AD' && meta['source'] !== 'GOOGLE') continue;
      await execute(
        `UPDATE entitlements SET active = 0, last_harvested_at = UTC_TIMESTAMP() WHERE id = ?`,
        [row.id],
      );
      deactivated++;
    }

    const status = errors.length && (harvested + updated) === 0
      ? 'FAILED'
      : errors.length
        ? 'PARTIAL'
        : 'SUCCESS';

    await execute(
      `UPDATE connector_runs SET
         status = ?, ended_at = UTC_TIMESTAMP(),
         items_processed = ?, items_succeeded = ?, items_failed = ?,
         error_summary = ?, payload = ?
       WHERE id = ?`,
      [
        status,
        harvested + updated + deactivated,
        harvested + updated,
        errors.length,
        errors.slice(0, 5).join('; ') || null,
        JSON.stringify({ triggeredBy, harvested, updated, deactivated, errors: errors.slice(0, 20) }),
        runId,
      ],
    );

    logger.info(
      { connectorId, runId, harvested, updated, deactivated, errors: errors.length },
      'Entitlement harvest complete',
    );

    return {
      connectorId,
      connectorName: connector.name,
      runId,
      harvested,
      updated,
      deactivated,
      errors,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await execute(
      `UPDATE connector_runs SET
         status = 'FAILED', ended_at = UTC_TIMESTAMP(),
         error_summary = ?, items_failed = 1
       WHERE id = ?`,
      [msg.slice(0, 500), runId],
    );
    throw err;
  }
}
