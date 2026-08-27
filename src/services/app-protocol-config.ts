/**
 * Application protocol bindings (SAML mirror + SCIM provisioning config).
 */

import { v4 as uuidv4 } from 'uuid';
import { execute, queryOne } from '../db/connection.js';
import { sealSecret } from '../utils/secret-box.js';
import logger from '../utils/logger.js';

export interface ScimProtocolConfigInput {
  baseUrl: string;
  bearerToken: string;
  deprovisionMode?: 'DEACTIVATE' | 'DELETE';
  provisionPath?: string;
}

export async function getApplicationIdBySlug(slug: string): Promise<string | null> {
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM applications WHERE slug = ? LIMIT 1`,
    [slug],
  );
  return row?.id ?? null;
}

export async function setApplicationProvisioning(slug: string, enabled: boolean): Promise<void> {
  await execute(
    `UPDATE applications SET provisioning = ?, updated_at = UTC_TIMESTAMP() WHERE slug = ?`,
    [enabled ? 1 : 0, slug],
  );
}

export async function upsertAppProtocolConfig(
  appId: string,
  protocol: 'SAML' | 'SCIM' | 'OIDC' | 'OAUTH2' | 'WS_FED' | 'CAS' | 'HEADER' | 'BOOKMARK',
  config: Record<string, unknown>,
): Promise<void> {
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM app_protocol_configs WHERE app_id = ? AND protocol = ? LIMIT 1`,
    [appId, protocol],
  );
  const json = JSON.stringify(config);
  if (existing) {
    await execute(
      `UPDATE app_protocol_configs SET config = ?, active = 1 WHERE id = ?`,
      [json, existing.id],
    );
  } else {
    await execute(
      `INSERT INTO app_protocol_configs (id, app_id, protocol, config, active) VALUES (?, ?, ?, ?, 1)`,
      [uuidv4(), appId, protocol, json],
    );
  }
}

export async function upsertScimProtocolConfig(
  appId: string,
  input: ScimProtocolConfigInput,
): Promise<void> {
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
  const bearerToken = input.bearerToken.trim();
  if (!baseUrl || !bearerToken) {
    throw new Error('SCIM base URL and bearer token are required');
  }
  await upsertAppProtocolConfig(appId, 'SCIM', {
    baseUrl,
    bearerToken: sealSecret(bearerToken),
    deprovisionMode: input.deprovisionMode ?? 'DEACTIVATE',
    provisionPath: input.provisionPath ?? '/Users',
  });
}

export async function syncSamlProtocolConfigFromSp(slug: string): Promise<void> {
  const sp = await queryOne<{
    entity_id: string;
    acs_url: string;
    slo_url: string | null;
    nameid_format: string;
    attribute_map: unknown;
  }>(
    `SELECT entity_id, acs_url, slo_url, nameid_format, attribute_map
       FROM saml_service_providers WHERE slug = ? LIMIT 1`,
    [slug],
  );
  if (!sp) return;

  const appId = await getApplicationIdBySlug(slug);
  if (!appId) return;

  const attrMap = sp.attribute_map && typeof sp.attribute_map === 'object'
    ? sp.attribute_map
    : (typeof sp.attribute_map === 'string'
      ? JSON.parse(sp.attribute_map || '{}')
      : {});

  await upsertAppProtocolConfig(appId, 'SAML', {
    entity_id: sp.entity_id,
    acs_url: sp.acs_url,
    slo_url: sp.slo_url,
    nameid_format: sp.nameid_format,
    attribute_map: attrMap,
  });
}

export async function configureAppScimProvisioning(
  slug: string,
  scim: ScimProtocolConfigInput,
): Promise<void> {
  const appId = await getApplicationIdBySlug(slug);
  if (!appId) throw new Error(`Application catalog row missing for slug ${slug}`);
  await upsertScimProtocolConfig(appId, scim);
  await setApplicationProvisioning(slug, true);
  logger.info({ slug, baseUrl: scim.baseUrl }, 'SCIM protocol config saved for application');
}
