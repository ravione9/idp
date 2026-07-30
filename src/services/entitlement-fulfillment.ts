/**
 * Entitlement Fulfillment
 * -----------------------
 * After an IGA entitlement grant/revoke, push membership to the target
 * directory (AD group / Google group) when the entitlement was harvested
 * from a connector (`external_id` + metadata.source).
 */

import { google } from 'googleapis';
import { queryOne, execute } from '../db/connection.js';
import { ADAdapter } from '../adapters/ad-adapter.js';
import { redis } from '../auth/session-store.js';
import { config } from '../config.js';
import { parseConnectorBoolean, parseConnectorPort } from '../utils/connector-config.js';
import { buildGoogleJwtAuth } from './google-directory-config.js';
import logger from '../utils/logger.js';

export interface FulfillResult {
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  detail: string;
}

interface EntRow {
  id: string;
  connector_id: string | null;
  external_id: string | null;
  type: string;
  metadata: unknown;
  name: string;
}

function parseMeta(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
  }
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  return {};
}

async function logProvision(
  entitlementId: string,
  empId: string,
  connectorId: string | null,
  action: 'GRANT' | 'REVOKE',
  result: FulfillResult,
  actorEmpId?: string,
): Promise<void> {
  try {
    await execute(
      `INSERT INTO entitlement_provision_log
         (entitlement_id, emp_id, connector_id, action, status, detail, actor_emp_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        entitlementId,
        empId,
        connectorId,
        action,
        result.status,
        result.detail.slice(0, 500),
        actorEmpId ?? null,
      ],
    );
  } catch (err) {
    logger.warn({ err }, 'entitlement_provision_log insert failed (migration 045 applied?)');
  }
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

async function resolveAdSam(empId: string): Promise<string | null> {
  const link = await queryOne<{ external_id: string }>(
    `SELECT external_id FROM identity_links
      WHERE emp_id = ? AND \`system\` = 'AD' AND status != 'DELETED'
      LIMIT 1`,
    [empId],
  );
  if (link?.external_id) return link.external_id;
  const emp = await queryOne<{ email_corp: string | null }>(
    `SELECT email_corp FROM employees WHERE emp_id = ?`,
    [empId],
  );
  return emp?.email_corp ?? null;
}

async function resolveGoogleEmail(empId: string): Promise<string | null> {
  const link = await queryOne<{ external_id: string }>(
    `SELECT external_id FROM identity_links
      WHERE emp_id = ? AND \`system\` = 'GOOGLE' AND status != 'DELETED'
      LIMIT 1`,
    [empId],
  );
  // Google identity_links.external_id is usually the Google user id; prefer email
  const emp = await queryOne<{ email_corp: string | null }>(
    `SELECT email_corp FROM employees WHERE emp_id = ?`,
    [empId],
  );
  if (emp?.email_corp) return emp.email_corp.toLowerCase();
  return link?.external_id ?? null;
}

async function fulfillAd(
  action: 'GRANT' | 'REVOKE',
  empId: string,
  groupKey: string,
  cfg: Record<string, unknown>,
): Promise<FulfillResult> {
  const userKey = await resolveAdSam(empId);
  if (!userKey) {
    return { status: 'SKIPPED', detail: 'No AD identity link / email for employee' };
  }
  const adapter = createAdAdapter(cfg);
  try {
    await adapter.connect();
    const res = action === 'GRANT'
      ? await adapter.addGroupMember(userKey, groupKey)
      : await adapter.removeGroupMember(userKey, groupKey);
    if (!res.success) {
      return { status: 'FAILED', detail: res.error ?? 'AD group membership failed' };
    }
    return {
      status: 'SUCCESS',
      detail: action === 'GRANT'
        ? `Added ${userKey} to AD group ${groupKey}`
        : `Removed ${userKey} from AD group ${groupKey}`,
    };
  } catch (err) {
    return { status: 'FAILED', detail: err instanceof Error ? err.message : String(err) };
  }
}

async function fulfillGoogle(
  action: 'GRANT' | 'REVOKE',
  empId: string,
  groupEmail: string,
  cfg: Record<string, unknown>,
): Promise<FulfillResult> {
  const memberEmail = await resolveGoogleEmail(empId);
  if (!memberEmail) {
    return { status: 'SKIPPED', detail: 'No Google email for employee' };
  }
  try {
    const auth = buildGoogleJwtAuth(cfg);
    const directory = google.admin({ version: 'directory_v1', auth });
    if (action === 'GRANT') {
      try {
        await directory.members.insert({
          groupKey: groupEmail,
          requestBody: { email: memberEmail, role: 'MEMBER' },
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/Member already exists|409/i.test(msg)) {
          return { status: 'SUCCESS', detail: `${memberEmail} already in ${groupEmail}` };
        }
        throw err;
      }
      return { status: 'SUCCESS', detail: `Added ${memberEmail} to Google group ${groupEmail}` };
    }

    try {
      await directory.members.delete({
        groupKey: groupEmail,
        memberKey: memberEmail,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/Resource Not Found|404|not found/i.test(msg)) {
        return { status: 'SUCCESS', detail: `${memberEmail} already absent from ${groupEmail}` };
      }
      throw err;
    }
    return { status: 'SUCCESS', detail: `Removed ${memberEmail} from Google group ${groupEmail}` };
  } catch (err) {
    return { status: 'FAILED', detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Push grant/revoke to the target system for a harvested entitlement.
 * No-ops (SKIPPED) for manual entitlements without connector + external_id.
 */
export async function fulfillEntitlementOnTarget(
  empId: string,
  entitlementId: string,
  action: 'GRANT' | 'REVOKE',
  actorEmpId?: string,
): Promise<FulfillResult> {
  const ent = await queryOne<EntRow>(
    `SELECT id, connector_id, external_id, type, metadata, name
       FROM entitlements WHERE id = ?`,
    [entitlementId],
  );
  if (!ent) {
    return { status: 'SKIPPED', detail: 'Entitlement not found' };
  }
  if (!ent.connector_id || !ent.external_id) {
    const result: FulfillResult = {
      status: 'SKIPPED',
      detail: 'Entitlement has no connector/external_id — IdP grant only',
    };
    await logProvision(entitlementId, empId, null, action, result, actorEmpId);
    return result;
  }

  const connector = await queryOne<{
    connector_type: string;
    slug: string;
    config_json: string | Record<string, unknown>;
    status: string;
  }>(
    `SELECT connector_type, slug, config_json, status FROM connectors WHERE id = ?`,
    [ent.connector_id],
  );
  if (!connector) {
    const result: FulfillResult = { status: 'FAILED', detail: 'Connector missing' };
    await logProvision(entitlementId, empId, ent.connector_id, action, result, actorEmpId);
    return result;
  }

  const cfg = typeof connector.config_json === 'string'
    ? JSON.parse(connector.config_json || '{}') as Record<string, unknown>
    : (connector.config_json ?? {});
  const meta = parseMeta(ent.metadata);
  const type = (connector.connector_type || '').toUpperCase();
  const source = String(meta['source'] || '').toUpperCase();

  let result: FulfillResult;
  if (type === 'AD' || type === 'LDAP' || source === 'AD' || connector.slug === 'active-directory') {
    result = await fulfillAd(action, empId, ent.external_id, cfg);
  } else if (
    type === 'GOOGLE'
    || type === 'GOOGLE_WORKSPACE'
    || source === 'GOOGLE'
    || connector.slug === 'google-workspace'
  ) {
    result = await fulfillGoogle(action, empId, ent.external_id, cfg);
  } else {
    result = {
      status: 'SKIPPED',
      detail: `No fulfillment handler for connector type ${connector.connector_type}`,
    };
  }

  await logProvision(entitlementId, empId, ent.connector_id, action, result, actorEmpId);
  logger.info(
    { empId, entitlementId, action, status: result.status, detail: result.detail },
    'Entitlement target fulfillment',
  );
  return result;
}
