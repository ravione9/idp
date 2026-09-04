/**
 * OIDC applications in the end-user portal catalog (mirrored into `applications`).
 */
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne, execute } from '../db/connection.js';
import logger from '../utils/logger.js';

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

function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
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

/**
 * Ensure an active OIDC client has a RESTRICTED `applications` row (required for Access Policy grants).
 */
export async function ensureOidcAppMirrored(oidcClientId: string): Promise<string | null> {
  const cols = await query<{ COLUMN_NAME: string }>(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'oidc_clients'`,
    [],
  );
  const colSet = new Set(cols.map((r) => r.COLUMN_NAME));
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
    const existing = await queryOne<{ id: string; visibility: string }>(
      `SELECT id, visibility FROM applications WHERE id = ? LIMIT 1`,
      [client.app_id],
    );
    if (existing) {
      if (existing.visibility !== 'RESTRICTED') {
        await execute(
          `UPDATE applications SET visibility = 'RESTRICTED' WHERE id = ?`,
          [existing.id],
        );
        logger.info({ oidcClientId, appId: existing.id }, 'Forced OIDC-linked application visibility to RESTRICTED');
      }
      return existing.id;
    }
  }

  const slug = await uniqueSlug(slugifyName(client.name || client.client_id));
  const appId = uuidv4();
  await execute(
    `INSERT INTO applications
       (id, slug, name, category, visibility, sso_enabled, provisioning, sort_order, active)
     VALUES (?, ?, ?, 'OIDC', 'RESTRICTED', 1, 0, 0, 1)`,
    [appId, slug, client.name || client.client_id],
  );

  if (hasAppId) {
    await execute(`UPDATE oidc_clients SET app_id = ? WHERE id = ?`, [appId, oidcClientId]);
  }

  logger.info({ oidcClientId, appId, slug }, 'Mirrored OIDC client into applications catalog as RESTRICTED');
  return appId;
}

export async function syncOidcAppsToCatalog(): Promise<number> {
  const clients = await query<{ id: string }>(
    `SELECT id FROM oidc_clients WHERE active = 1`,
    [],
  );
  let touched = 0;
  for (const c of clients) {
    const before = await queryOne<{ app_id: string | null }>(
      `SELECT app_id FROM oidc_clients WHERE id = ?`,
      [c.id],
    );
    await ensureOidcAppMirrored(c.id);
    const after = await queryOne<{ app_id: string | null }>(
      `SELECT app_id FROM oidc_clients WHERE id = ?`,
      [c.id],
    );
    if (before?.app_id !== after?.app_id) touched += 1;
  }
  if (touched > 0) {
    logger.info({ touched }, 'Synced OIDC clients into applications catalog');
  }
  return touched;
}

export async function getActiveOidcPortalApps(): Promise<OidcPortalApp[]> {
  await syncOidcAppsToCatalog();

  const colRows = await query<{ COLUMN_NAME: string }>(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'oidc_clients'`,
    [],
  );
  const colSet = new Set(colRows.map((r) => r.COLUMN_NAME));
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
