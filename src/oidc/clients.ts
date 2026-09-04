/**
 * OIDC client registry lookups used by the authorization server.
 */
import bcrypt from 'bcryptjs';
import { query, queryOne } from '../db/connection.js';
import { redirectUrisMatch } from './redirect-uris.js';

export interface OidcClient {
  id: string;
  clientId: string;
  clientSecretHash: string | null;
  name: string;
  clientType: 'CONFIDENTIAL' | 'PUBLIC';
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  scopes: string[];
  tokenEndpointAuthMethod: string;
  requirePkce: boolean;
  active: boolean;
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

export async function getOidcClientByClientId(clientId: string): Promise<OidcClient | null> {
  const cols = await oidcColumnSet();
  const nameExpr = cols.has('name') ? 'name' : 'client_id AS name';
  const authExpr = cols.has('token_endpoint_auth_method')
    ? 'token_endpoint_auth_method'
    : cols.has('token_endpoint_auth')
      ? 'token_endpoint_auth AS token_endpoint_auth_method'
      : "'client_secret_basic' AS token_endpoint_auth_method";
  const typeExpr = cols.has('client_type')
    ? 'client_type'
    : "'CONFIDENTIAL' AS client_type";
  const pkceExpr = cols.has('require_pkce')
    ? 'require_pkce'
    : '1 AS require_pkce';

  const row = await queryOne<{
    id: string;
    client_id: string;
    client_secret_hash: string | null;
    name: string;
    client_type: string;
    redirect_uris: unknown;
    grant_types: unknown;
    response_types: unknown;
    scopes: unknown;
    token_endpoint_auth_method: string;
    require_pkce: number | boolean;
    active: number | boolean;
  }>(
    `SELECT id, client_id, client_secret_hash, ${nameExpr}, ${typeExpr},
            redirect_uris, grant_types, response_types, scopes,
            ${authExpr}, ${pkceExpr}, active
       FROM oidc_clients
      WHERE client_id = ?`,
    [clientId],
  );

  if (!row || !row.active) return null;

  return {
    id: row.id,
    clientId: row.client_id,
    clientSecretHash: row.client_secret_hash,
    name: row.name || row.client_id,
    clientType: row.client_type === 'PUBLIC' ? 'PUBLIC' : 'CONFIDENTIAL',
    redirectUris: parseJsonArray(row.redirect_uris),
    grantTypes: parseJsonArray(row.grant_types),
    responseTypes: parseJsonArray(row.response_types),
    scopes: parseJsonArray(row.scopes),
    tokenEndpointAuthMethod: row.token_endpoint_auth_method || 'client_secret_basic',
    requirePkce: row.require_pkce === true || row.require_pkce === 1 || row.require_pkce === undefined,
    active: true,
  };
}

export function isRedirectUriAllowed(client: OidcClient, redirectUri: string): boolean {
  return client.redirectUris.some((r) => redirectUrisMatch(r, redirectUri));
}

export function intersectScopes(requested: string[], allowed: string[]): string[] {
  const allow = new Set(allowed.length ? allowed : ['openid', 'email', 'profile']);
  const req = requested.length ? requested : ['openid'];
  return req.filter((s) => allow.has(s));
}

export async function verifyClientSecret(client: OidcClient, secret: string | undefined): Promise<boolean> {
  if (client.clientType === 'PUBLIC' || client.tokenEndpointAuthMethod === 'none') {
    return true;
  }
  if (!secret || !client.clientSecretHash) return false;
  return bcrypt.compare(secret, client.clientSecretHash);
}
