/**
 * OIDC applications in the end-user portal catalog (mirrored into `applications`).
 */
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne, execute } from '../db/connection.js';
import logger from '../utils/logger.js';
import { resolveOidcCatalogSlug, GENERIC_CATALOG_SLUGS } from '../utils/app-slug.js';

export interface OidcPortalApp {
  id: string;
  clientId: string;
  slug: string;
  name: string;
  iconUrl: string | null;
  redirectUris: string[];
  scopes: string[];
}

function parseJsonArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function oidcColumnSet(): Promise<Set<string>> {
  const colRows = await query<{ COLUMN_NAME: string }>(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'oidc_clients'`,
    [],
  );
  return new Set(colRows.map((r) => r.COLUMN_NAME));
}

async function uniqueSlug(base: string): Promise<string> {
  const root = base || 'oidc-app';
  let candidate = root;
  let n = 2;
  while (await queryOne<{ id: string }>(
    `SELECT id FROM applications WHERE slug = ? LIMIT 1`,
    [candidate],
  )) {
    candidate = `${root}-${n}`.slice(0, 80);
    n += 1;
  }
  return candidate;
}

export async function resolveOrCreateOidcCatalogApp(params: {
  name: string;
  catalogSlug?: string | null;
  category?: string | null;
}): Promise<string> {
  const slug = await uniqueSlug(resolveOidcCatalogSlug(params.name, params.catalogSlug));
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM applications WHERE slug = ? LIMIT 1`,
    [slug],
  );
  if (existing) {
    await execute(
      `UPDATE applications
          SET active = 1, visibility = 'RESTRICTED', name = ?,
              category = COALESCE(?, category), sso_enabled = 1
        WHERE id = ?`,
      [params.name, params.category ?? null, existing.id],
    );
    return existing.id;
  }

  const appId = uuidv4();
  await execute(
    `INSERT INTO applications
       (id, slug, name, category, visibility, sso_enabled, provisioning, sort_order, active)
     VALUES (?, ?, ?, ?, 'RESTRICTED', 1, 0, 0, 1)`,
    [appId, slug, params.name, params.category ?? 'OIDC'],
  );
  logger.info({ appId, slug, name: params.name }, 'Created OIDC application catalog row');
  return appId;
}

async function linkOidcClientToApp(oidcClientId: string, appId: string, hasAppId: boolean): Promise<void> {
  if (!hasAppId) return;
  await execute(`UPDATE oidc_clients SET app_id = ? WHERE id = ?`, [appId, oidcClientId]);
}

async function repairLinkedCatalogApp(
  appId: string,
  clientName: string,
  category: string | null,
): Promise<string> {
  const row = await queryOne<{ id: string; slug: string; visibility: string; active: number }>(
    `SELECT id, slug, visibility, active FROM applications WHERE id = ? LIMIT 1`,
    [appId],
  );
  if (!row) return appId;

  const desiredSlug = resolveOidcCatalogSlug(clientName);
  if (GENERIC_CATALOG_SLUGS.has(row.slug) && desiredSlug && desiredSlug !== row.slug) {
    const target = await queryOne<{ id: string }>(
      `SELECT id FROM applications WHERE slug = ? LIMIT 1`,
      [desiredSlug],
    );
    if (target) {
      await execute(
        `UPDATE applications
            SET active = 1, visibility = 'RESTRICTED', name = ?
          WHERE id = ?`,
        [clientName, target.id],
      );
      return target.id;
    }
    await execute(
      `UPDATE applications
          SET slug = ?, name = ?, active = 1, visibility = 'RESTRICTED',
              category = COALESCE(?, category)
        WHERE id = ?`,
      [desiredSlug, clientName, category, row.id],
    );
    logger.info({ appId: row.id, from: row.slug, to: desiredSlug }, 'Renamed generic OIDC catalog slug');
    return row.id;
  }

  if (row.visibility !== 'RESTRICTED' || Number(row.active) !== 1) {
    await execute(
      `UPDATE applications SET visibility = 'RESTRICTED', active = 1, name = ? WHERE id = ?`,
      [clientName, row.id],
    );
  }
  return row.id;
}

/**
 * Ensure an active OIDC client has a RESTRICTED `applications` row (required for Access Policy grants).
 */
export async function ensureOidcAppMirrored(oidcClientId: string): Promise<string | null> {
  const colSet = await oidcColumnSet();
  const nameExpr = colSet.has('name') ? 'name' : 'client_id AS name';
  const hasAppId = colSet.has('app_id');

  const client = await queryOne<{
    id: string;
    client_id: string;
    name: string;
    app_id: string | null;
    active: number;
  }>(
    `SELECT id, client_id, ${nameExpr}, ${hasAppId ? 'app_id' : 'NULL AS app_id'}, active
       FROM oidc_clients WHERE id = ? LIMIT 1`,
    [oidcClientId],
  );
  if (!client || !client.active) return null;

  if (hasAppId && client.app_id) {
    const repairedId = await repairLinkedCatalogApp(client.app_id, client.name, 'OIDC');
    await linkOidcClientToApp(oidcClientId, repairedId, hasAppId);
    return repairedId;
  }

  const desiredSlug = resolveOidcCatalogSlug(client.name);
  const bySlug = desiredSlug
    ? await queryOne<{ id: string }>(
      `SELECT id FROM applications WHERE slug = ? LIMIT 1`,
      [desiredSlug],
    )
    : null;
  if (bySlug) {
    await execute(
      `UPDATE applications
          SET active = 1, visibility = 'RESTRICTED', name = ?, sso_enabled = 1
        WHERE id = ?`,
      [client.name, bySlug.id],
    );
    await linkOidcClientToApp(oidcClientId, bySlug.id, hasAppId);
    return bySlug.id;
  }

  const appId = await resolveOrCreateOidcCatalogApp({
    name: client.name || client.client_id,
    catalogSlug: client.name,
    category: 'OIDC',
  });
  await linkOidcClientToApp(oidcClientId, appId, hasAppId);
  return appId;
}

export async function syncOidcAppsToCatalog(): Promise<number> {
  const colSet = await oidcColumnSet();
  const hasAppId = colSet.has('app_id');

  const clients = await query<{ id: string }>(
    `SELECT id FROM oidc_clients WHERE active = 1`,
    [],
  );
  let touched = 0;
  for (const c of clients) {
    let beforeAppId: string | null = null;
    if (hasAppId) {
      const before = await queryOne<{ app_id: string | null }>(
        `SELECT app_id FROM oidc_clients WHERE id = ?`,
        [c.id],
      );
      beforeAppId = before?.app_id ?? null;
    }
    const appId = await ensureOidcAppMirrored(c.id);
    if (hasAppId) {
      const after = await queryOne<{ app_id: string | null }>(
        `SELECT app_id FROM oidc_clients WHERE id = ?`,
        [c.id],
      );
      if (beforeAppId !== (after?.app_id ?? null)) touched += 1;
    } else if (appId) {
      touched += 1;
    }
  }
  if (touched > 0) {
    logger.info({ touched }, 'Synced OIDC clients into applications catalog');
  }
  return touched;
}

export async function getActiveOidcPortalApps(): Promise<OidcPortalApp[]> {
  await syncOidcAppsToCatalog();

  const colSet = await oidcColumnSet();
  if (!colSet.has('app_id')) return [];

  const nameExpr = colSet.has('name') ? 'c.name' : 'c.client_id AS name';
  const rows = await query<{
    id: string;
    client_id: string;
    name: string;
    redirect_uris: unknown;
    scopes: unknown;
    slug: string;
    app_name: string;
    icon_url: string | null;
  }>(
    `SELECT c.id, c.client_id, ${nameExpr},
            c.redirect_uris, c.scopes,
            a.slug, a.name AS app_name, a.icon_url
       FROM oidc_clients c
       INNER JOIN applications a ON a.id = c.app_id
      WHERE c.active = 1 AND a.active = 1
      ORDER BY a.sort_order ASC, a.name ASC`,
    [],
  );

  return rows.map((row) => ({
    id: row.id,
    clientId: row.client_id,
    slug: row.slug,
    name: row.app_name || row.name,
    iconUrl: row.icon_url,
    redirectUris: parseJsonArray(row.redirect_uris),
    scopes: parseJsonArray(row.scopes),
  }));
}

export async function getOidcPortalAppBySlug(slug: string): Promise<OidcPortalApp | null> {
  const apps = await getActiveOidcPortalApps();
  return apps.find((a) => a.slug === slug) ?? null;
}

export async function getOidcPortalAppByClientId(clientId: string): Promise<OidcPortalApp | null> {
  const apps = await getActiveOidcPortalApps();
  return apps.find((a) => a.clientId === clientId) ?? null;
}
