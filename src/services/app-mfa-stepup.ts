/**
 * Application-level MFA (critical apps) — fresh MFA required at SAML/OIDC launch.
 *
 * Controlled by:
 *   - mfa_policy.critical_app_mfa (global kill-switch, default on)
 *   - mfa_policy.critical_app_mfa_max_age_seconds (default max age when app has none)
 *   - applications.require_mfa + applications.mfa_step_up_max_age_seconds
 */

import type { Request, Response } from 'express';
import { query, queryOne } from '../db/connection.js';
import { redis } from '../auth/session-store.js';
import logger from '../utils/logger.js';

const MFA_FRESH_PREFIX = 'idp:mfa-fresh:';
/** Keep freshness marker at least as long as a typical portal session idle window. */
const MFA_FRESH_REDIS_TTL_S = 12 * 3600;

function parsePolicyBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const s = String(raw).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === '"1"' || s === '"true"') return true;
  if (s === '0' || s === 'false' || s === '"0"' || s === '"false"') return false;
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') return v === '1' || v.toLowerCase() === 'true';
  } catch { /* ignore */ }
  return fallback;
}

function parsePolicyInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  try {
    const v = JSON.parse(raw) as unknown;
    const n = typeof v === 'number' ? v : parseInt(String(v), 10);
    if (Number.isFinite(n)) return Math.max(0, Math.min(86400, n));
  } catch {
    const n = parseInt(String(raw), 10);
    if (Number.isFinite(n)) return Math.max(0, Math.min(86400, n));
  }
  return fallback;
}

export async function getCriticalAppMfaPolicy(): Promise<{
  enabled: boolean;
  defaultMaxAgeSeconds: number;
}> {
  const rows = await query<{ policy_key: string; policy_value: string }>(
    `SELECT policy_key, policy_value FROM mfa_policy
      WHERE policy_key IN ('critical_app_mfa', 'critical_app_mfa_max_age_seconds')`,
    [],
  ).catch((err) => {
    logger.warn({ err }, 'critical_app_mfa policy lookup failed');
    return [] as { policy_key: string; policy_value: string }[];
  });
  const map = new Map(rows.map((r) => [r.policy_key, r.policy_value]));
  return {
    enabled: parsePolicyBool(map.get('critical_app_mfa'), true),
    defaultMaxAgeSeconds: parsePolicyInt(map.get('critical_app_mfa_max_age_seconds'), 300),
  };
}

export interface CriticalAppMfaTarget {
  slug: string;
  name: string;
  requireMfa: boolean;
  maxAgeSeconds: number;
}

export async function getAppMfaBySlug(slug: string): Promise<CriticalAppMfaTarget | null> {
  const row = await queryOne<{
    slug: string;
    name: string;
    require_mfa: number;
    mfa_step_up_max_age_seconds: number | null;
  }>(
    `SELECT slug, name, COALESCE(require_mfa, 0) AS require_mfa,
            mfa_step_up_max_age_seconds
       FROM applications
      WHERE slug = ? AND active = 1
      LIMIT 1`,
    [slug],
  ).catch(() => null);
  if (!row) return null;
  const policy = await getCriticalAppMfaPolicy();
  const maxAge = row.mfa_step_up_max_age_seconds != null
    ? Math.max(0, Math.min(86400, Number(row.mfa_step_up_max_age_seconds)))
    : policy.defaultMaxAgeSeconds;
  return {
    slug: row.slug,
    name: row.name,
    requireMfa: Number(row.require_mfa) === 1,
    maxAgeSeconds: maxAge,
  };
}

/** Resolve critical-app MFA via OIDC client → applications.app_id. */
export async function getAppMfaByOidcClientId(clientId: string): Promise<CriticalAppMfaTarget | null> {
  const row = await queryOne<{
    slug: string;
    name: string;
    require_mfa: number;
    mfa_step_up_max_age_seconds: number | null;
  }>(
    `SELECT a.slug, a.name, COALESCE(a.require_mfa, 0) AS require_mfa,
            a.mfa_step_up_max_age_seconds
       FROM oidc_clients c
       JOIN applications a ON a.id = c.app_id
      WHERE c.client_id = ? AND a.active = 1
      LIMIT 1`,
    [clientId],
  ).catch(() => null);
  if (!row) return null;
  const policy = await getCriticalAppMfaPolicy();
  const maxAge = row.mfa_step_up_max_age_seconds != null
    ? Math.max(0, Math.min(86400, Number(row.mfa_step_up_max_age_seconds)))
    : policy.defaultMaxAgeSeconds;
  return {
    slug: row.slug,
    name: row.name,
    requireMfa: Number(row.require_mfa) === 1,
    maxAgeSeconds: maxAge,
  };
}

export async function markSessionMfaFresh(sessionId: string): Promise<void> {
  if (!sessionId) return;
  await redis.set(
    `${MFA_FRESH_PREFIX}${sessionId}`,
    String(Date.now()),
    'EX',
    MFA_FRESH_REDIS_TTL_S,
  );
}

export async function isSessionMfaFresh(sessionId: string, maxAgeSeconds: number): Promise<boolean> {
  if (!sessionId) return false;
  // maxAge 0 = require MFA on every launch (never trust prior verification)
  if (maxAgeSeconds <= 0) return false;
  const raw = await redis.get(`${MFA_FRESH_PREFIX}${sessionId}`);
  if (!raw) return false;
  const ts = parseInt(raw, 10);
  if (!Number.isFinite(ts)) return false;
  return (Date.now() - ts) <= maxAgeSeconds * 1000;
}

/**
 * Returns true when SSO may proceed; false when caller must redirect to app MFA step-up.
 */
export async function sessionSatisfiesAppMfa(
  sessionId: string,
  app: CriticalAppMfaTarget | null,
): Promise<boolean> {
  const policy = await getCriticalAppMfaPolicy();
  if (!policy.enabled) return true;
  if (!app?.requireMfa) return true;
  return isSessionMfaFresh(sessionId, app.maxAgeSeconds);
}

export function appMfaStepUpLoginUrl(returnPath: string, appName: string): string {
  const safeReturn = returnPath.startsWith('/') && !returnPath.startsWith('//')
    ? returnPath.slice(0, 500)
    : '/';
  const params = new URLSearchParams({
    app_mfa: '1',
    returnTo: safeReturn,
    app: appName.slice(0, 120),
  });
  return `/login?${params.toString()}`;
}

/** Redirect browser to login MFA step-up for a critical app. */
export function redirectAppMfaStepUp(res: Response, returnPath: string, appName: string): void {
  res.redirect(303, appMfaStepUpLoginUrl(returnPath, appName));
}

export async function listCriticalApps(): Promise<Array<{
  id: string;
  slug: string;
  name: string;
  require_mfa: boolean;
  mfa_step_up_max_age_seconds: number;
  has_saml: boolean;
}>> {
  const rows = await query<{
    id: string;
    slug: string;
    name: string;
    require_mfa: number;
    mfa_step_up_max_age_seconds: number;
    has_saml: number;
  }>(
    `SELECT a.id, a.slug, a.name,
            COALESCE(a.require_mfa, 0) AS require_mfa,
            COALESCE(a.mfa_step_up_max_age_seconds, 300) AS mfa_step_up_max_age_seconds,
            EXISTS (
              SELECT 1 FROM saml_service_providers sp
               WHERE sp.slug = a.slug AND sp.active = 1
            ) AS has_saml
       FROM applications a
      WHERE a.active = 1
      ORDER BY a.require_mfa DESC, a.name ASC
      LIMIT 200`,
    [],
  ).catch(() => []);
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    require_mfa: Number(r.require_mfa) === 1,
    mfa_step_up_max_age_seconds: Number(r.mfa_step_up_max_age_seconds) || 300,
    has_saml: Number(r.has_saml) === 1,
  }));
}

export async function setApplicationRequireMfa(
  slugOrId: string,
  requireMfa: boolean,
  maxAgeSeconds?: number,
): Promise<boolean> {
  const sets = ['require_mfa = ?', 'updated_at = UTC_TIMESTAMP()'];
  const params: unknown[] = [requireMfa ? 1 : 0];
  if (maxAgeSeconds !== undefined) {
    sets.push('mfa_step_up_max_age_seconds = ?');
    params.push(Math.max(0, Math.min(86400, maxAgeSeconds)));
  }
  params.push(slugOrId, slugOrId);
  const result = await executeUpdate(
    `UPDATE applications SET ${sets.join(', ')} WHERE id = ? OR slug = ?`,
    params,
  );
  return result > 0;
}

async function executeUpdate(sql: string, params: unknown[]): Promise<number> {
  const { execute } = await import('../db/connection.js');
  const result = await execute(sql, params);
  return result.affectedRows ?? 0;
}

/** Convenience used by SAML/OIDC handlers. */
export async function enforceCriticalAppMfaOrRedirect(
  _req: Request,
  res: Response,
  opts: {
    sessionId: string;
    returnPath: string;
    app: CriticalAppMfaTarget | null;
  },
): Promise<boolean> {
  const ok = await sessionSatisfiesAppMfa(opts.sessionId, opts.app);
  if (ok) return true;
  logger.info(
    { sessionId: opts.sessionId, slug: opts.app?.slug, returnPath: opts.returnPath },
    'Critical app MFA step-up required',
  );
  redirectAppMfaStepUp(res, opts.returnPath, opts.app?.name || opts.app?.slug || 'application');
  return false;
}
