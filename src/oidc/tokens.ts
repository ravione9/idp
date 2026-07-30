/**
 * Authorization codes, refresh tokens, and JWT access / ID tokens.
 */
import crypto from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { SignJWT } from 'jose';
import { execute, queryOne } from '../db/connection.js';
import { getOidcKeyId, getOidcPrivateKey } from './keys.js';
import type { UserClaims } from './claims.js';

export const AUTH_CODE_TTL_S = 600;       // 10 min
export const ACCESS_TOKEN_TTL_S = 3600;   // 1 hour
export const REFRESH_TOKEN_TTL_S = 2_592_000; // 30 days

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function mysqlUtc(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export async function issueAuthorizationCode(params: {
  clientId: string;
  empId: string;
  scope: string;
  redirectUri: string;
  nonce?: string;
  pkceChallenge?: string;
  pkceMethod?: string;
}): Promise<string> {
  const code = randomToken(32);
  const id = uuidv4();
  const expires = new Date(Date.now() + AUTH_CODE_TTL_S * 1000);
  await execute(
    `INSERT INTO oauth_tokens
       (id, type, client_id, emp_id, token_hash, scope, nonce, redirect_uri,
        pkce_challenge, pkce_method, issued_at, expires_at)
     VALUES (?, 'AUTHZ_CODE', ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), ?)`,
    [
      id,
      params.clientId,
      params.empId,
      hashToken(code),
      params.scope,
      params.nonce ?? null,
      params.redirectUri,
      params.pkceChallenge ?? null,
      params.pkceMethod ?? null,
      mysqlUtc(expires),
    ],
  );
  return code;
}

export interface StoredAuthCode {
  id: string;
  clientId: string;
  empId: string;
  scope: string | null;
  nonce: string | null;
  redirectUri: string | null;
  pkceChallenge: string | null;
  pkceMethod: string | null;
}

export async function consumeAuthorizationCode(code: string): Promise<StoredAuthCode | null> {
  const row = await queryOne<{
    id: string;
    client_id: string;
    emp_id: string;
    scope: string | null;
    nonce: string | null;
    redirect_uri: string | null;
    pkce_challenge: string | null;
    pkce_method: string | null;
  }>(
    `SELECT id, client_id, emp_id, scope, nonce, redirect_uri, pkce_challenge, pkce_method
       FROM oauth_tokens
      WHERE type = 'AUTHZ_CODE'
        AND token_hash = ?
        AND revoked_at IS NULL
        AND expires_at > UTC_TIMESTAMP()`,
    [hashToken(code)],
  );
  if (!row) return null;

  // One-time use
  await execute(
    `UPDATE oauth_tokens SET revoked_at = UTC_TIMESTAMP() WHERE id = ?`,
    [row.id],
  );

  return {
    id: row.id,
    clientId: row.client_id,
    empId: row.emp_id,
    scope: row.scope,
    nonce: row.nonce,
    redirectUri: row.redirect_uri,
    pkceChallenge: row.pkce_challenge,
    pkceMethod: row.pkce_method,
  };
}

export function verifyPkce(
  method: string | null | undefined,
  challenge: string | null | undefined,
  verifier: string | undefined,
): boolean {
  if (!challenge) return true; // client did not use PKCE
  if (!verifier) return false;
  // IDP-02 — reject plain PKCE (verifier === challenge).
  if ((method ?? '').toLowerCase() !== 's256') return false;
  const computed = crypto.createHash('sha256').update(verifier).digest('base64url');
  return computed === challenge;
}

export async function issueRefreshToken(params: {
  clientId: string;
  empId: string;
  scope: string;
}): Promise<string> {
  const token = randomToken(48);
  const id = uuidv4();
  const expires = new Date(Date.now() + REFRESH_TOKEN_TTL_S * 1000);
  await execute(
    `INSERT INTO oauth_tokens
       (id, type, client_id, emp_id, token_hash, scope, issued_at, expires_at)
     VALUES (?, 'REFRESH', ?, ?, ?, ?, UTC_TIMESTAMP(), ?)`,
    [id, params.clientId, params.empId, hashToken(token), params.scope, mysqlUtc(expires)],
  );
  return token;
}

export async function consumeRefreshToken(token: string): Promise<{
  id: string;
  clientId: string;
  empId: string;
  scope: string | null;
} | null> {
  const row = await queryOne<{
    id: string;
    client_id: string;
    emp_id: string;
    scope: string | null;
  }>(
    `SELECT id, client_id, emp_id, scope
       FROM oauth_tokens
      WHERE type = 'REFRESH'
        AND token_hash = ?
        AND revoked_at IS NULL
        AND expires_at > UTC_TIMESTAMP()`,
    [hashToken(token)],
  );
  if (!row) return null;

  // Rotate: revoke old refresh token
  await execute(
    `UPDATE oauth_tokens SET revoked_at = UTC_TIMESTAMP(), last_used_at = UTC_TIMESTAMP() WHERE id = ?`,
    [row.id],
  );

  return {
    id: row.id,
    clientId: row.client_id,
    empId: row.emp_id,
    scope: row.scope,
  };
}

export async function mintAccessToken(params: {
  issuer: string;
  clientId: string;
  claims: UserClaims;
  scope: string;
}): Promise<{ accessToken: string; expiresIn: number }> {
  const now = Math.floor(Date.now() / 1000);
  const accessToken = await new SignJWT({
    scope: params.scope,
    email: params.claims.email,
    name: params.claims.name,
    emp_id: params.claims.emp_id,
    role: params.claims.role,
    token_use: 'access',
  })
    .setProtectedHeader({ alg: 'RS256', kid: getOidcKeyId(), typ: 'JWT' })
    .setIssuer(params.issuer)
    .setAudience(params.clientId)
    .setSubject(params.claims.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + ACCESS_TOKEN_TTL_S)
    .setJti(uuidv4())
    .sign(getOidcPrivateKey());

  return { accessToken, expiresIn: ACCESS_TOKEN_TTL_S };
}

export async function mintIdToken(params: {
  issuer: string;
  clientId: string;
  claims: UserClaims;
  nonce?: string | null;
  authTime?: number;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    email: params.claims.email,
    email_verified: params.claims.email_verified,
    name: params.claims.name,
    preferred_username: params.claims.preferred_username,
    given_name: params.claims.given_name,
    family_name: params.claims.family_name,
    emp_id: params.claims.emp_id,
    role: params.claims.role,
  };
  if (params.nonce) payload['nonce'] = params.nonce;
  if (params.authTime) payload['auth_time'] = params.authTime;

  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: getOidcKeyId(), typ: 'JWT' })
    .setIssuer(params.issuer)
    .setAudience(params.clientId)
    .setSubject(params.claims.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + ACCESS_TOKEN_TTL_S)
    .setJti(uuidv4())
    .sign(getOidcPrivateKey());
}
