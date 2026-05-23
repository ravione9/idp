/**
 * LILG Auth Middleware
 * --------------------
 * - HMAC-signed session cookies
 * - OIDC callback handlers for Google and Zoho
 * - Session lookup: Redis (hot) → DB (fallback)
 * - Logout with IDP end_session redirect
 */

import { Request, Response, NextFunction } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from '../config.js';
import { query, queryOne } from '../db/connection.js';
import { redis } from './session-store.js';
import logger from '../utils/logger.js';
import { parseOAuthState } from './login-routes.js';
import {
  COOKIE_NAME,
  SESSION_REDIS_PREFIX,
  verifySessionCookie,
  createSession,
  setSessionCookie,
  cacheSessionUser,
} from './session.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
import type { LilgUser } from './types.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: LilgUser;
    }
  }
}

export type { LilgUser };

// ---------------------------------------------------------------------------
// JWKS sets (cached in-process)
// ---------------------------------------------------------------------------
const googleJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const zohoJwks   = createRemoteJWKSet(new URL('https://accounts.zoho.in/oauth/v2/certs'));

// ---------------------------------------------------------------------------
// Cookie helpers — see session.ts
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Session cache helpers
// ---------------------------------------------------------------------------

async function getSessionFromRedis(sessionId: string): Promise<LilgUser | null> {
  const raw = await redis.get(`${SESSION_REDIS_PREFIX}${sessionId}`);
  if (!raw) return null;
  const u = JSON.parse(raw) as LilgUser;
  u.expiresAt = new Date(u.expiresAt);
  return u;
}

async function getSessionFromDb(sessionId: string): Promise<LilgUser | null> {
  const row = await queryOne<{
    session_id: string;
    emp_id:     string;
    email:      string;
    role:       string;
    iss:        string;
    sub:        string;
    expires_at: Date;
    revoked_at: Date | null;
  }>(
    `SELECT session_id, emp_id, email, role, iss, sub, expires_at, revoked_at
       FROM lilg_sessions
      WHERE session_id = ?`,
    [sessionId],
  );

  if (!row || row.revoked_at !== null) return null;
  if (new Date(row.expires_at) < new Date()) return null;

  const user: LilgUser = {
    sessionId:  row.session_id,
    empId:      row.emp_id,
    email:      row.email,
    role:       row.role,
    iss:        row.iss,
    sub:        row.sub,
    expiresAt:  new Date(row.expires_at),
  };

  // Backfill Redis cache
  await cacheSessionUser(user);
  return user;
}

// ---------------------------------------------------------------------------
// requireAuth middleware
// ---------------------------------------------------------------------------
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  void (async () => {
    const cookieHeader = req.headers['cookie'] ?? '';
    const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
    if (!match) {
      res.status(401).json({ error: 'Unauthenticated', code: 'NO_SESSION' });
      return;
    }

    const sessionId = verifySessionCookie(match[1]);
    if (!sessionId) {
      res.status(401).json({ error: 'Invalid session cookie', code: 'BAD_SIGNATURE' });
      return;
    }

    let user = await getSessionFromRedis(sessionId);
    if (!user) {
      user = await getSessionFromDb(sessionId);
    }

    if (!user) {
      res.clearCookie(COOKIE_NAME);
      res.status(401).json({ error: 'Session expired or revoked', code: 'SESSION_EXPIRED' });
      return;
    }

    // Slide last_active_at in DB (async, non-blocking)
    void query(
      'UPDATE lilg_sessions SET last_active_at = UTC_TIMESTAMP() WHERE session_id = ?',
      [sessionId],
    ).catch((err) => logger.warn({ err }, 'Failed to update last_active_at'));

    req.user = user;
    next();
  })();
}

// ---------------------------------------------------------------------------
// createSession — see session.ts
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// googleCallbackHandler
// ---------------------------------------------------------------------------
export async function googleCallbackHandler(req: Request, res: Response): Promise<void> {
  const code = req.query['code'] as string | undefined;
  if (!code) {
    res.status(400).json({ error: 'Missing code' });
    return;
  }

  try {
    // Exchange code for tokens
    const tokenRes = await (await import('axios')).default.post<{
      id_token: string;
      access_token: string;
      expires_in: number;
    }>(
      'https://oauth2.googleapis.com/token',
      new URLSearchParams({
        code,
        client_id:     config.google.clientId,
        client_secret: config.google.clientSecret,
        redirect_uri:  `${config.app.publicBaseUrl ?? `${req.protocol}://${req.get('host')}`}/auth/google/callback`,
        grant_type:    'authorization_code',
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10_000 },
    );

    const { id_token } = tokenRes.data;

    // Verify id_token
    const { payload } = await jwtVerify(id_token, googleJwks, {
      issuer:   ['accounts.google.com', 'https://accounts.google.com'],
      audience: config.google.clientId,
    });

    if (payload['hd'] !== config.google.hostedDomain) {
      res.status(403).json({ error: 'Wrong hosted domain' });
      return;
    }
    if (!payload['email_verified']) {
      res.status(403).json({ error: 'Email not verified' });
      return;
    }

    const email = payload['email'] as string;
    const sub   = payload['sub'] as string;

    // Lookup employee by corporate email
    const emp = await queryOne<{ emp_id: string; role: string }>(
      'SELECT emp_id, role FROM employees WHERE email_corp = ? AND ilg_state = ?',
      [email, 'ACTIVE'],
    );

    if (!emp) {
      res.status(403).json({ error: 'No active employee record for this account' });
      return;
    }

    const sessionId = await createSession({
      empId:     emp.emp_id,
      email,
      role:      emp.role ?? 'EMPLOYEE',
      iss:       'google',
      sub,
      ttlHours:  config.session.ttlCorporateHours,
      ip:        req.ip ?? '',
      userAgent: req.get('user-agent') ?? '',
    });

    setSessionCookie(res, sessionId, config.session.ttlCorporateHours);
    const { returnTo } = parseOAuthState(req.query['state'] as string | undefined);
    res.redirect(returnTo === '/' ? '/login' : returnTo);
  } catch (err) {
    logger.error({ err }, 'Google OIDC callback failed');
    res.status(500).json({ error: 'Authentication failed' });
  }
}

// ---------------------------------------------------------------------------
// zohoCallbackHandler
// ---------------------------------------------------------------------------
export async function zohoCallbackHandler(req: Request, res: Response): Promise<void> {
  const code = req.query['code'] as string | undefined;
  if (!code) {
    res.status(400).json({ error: 'Missing code' });
    return;
  }

  try {
    const tokenRes = await (await import('axios')).default.post<{
      id_token: string;
      access_token: string;
    }>(
      'https://accounts.zoho.in/oauth/v2/token',
      new URLSearchParams({
        code,
        client_id:     config.zoho.clientId,
        client_secret: config.zoho.clientSecret,
        redirect_uri:  `${config.app.publicBaseUrl ?? `${req.protocol}://${req.get('host')}`}/auth/zoho/callback`,
        grant_type:    'authorization_code',
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10_000 },
    );

    const { id_token } = tokenRes.data;

    const { payload } = await jwtVerify(id_token, zohoJwks, {
      issuer:   'https://accounts.zoho.in',
      audience: config.zoho.clientId,
    });

    const email = payload['email'] as string;
    const sub   = payload['sub'] as string;

    const emp = await queryOne<{ emp_id: string; role: string }>(
      'SELECT emp_id, role FROM employees WHERE email_corp = ? AND ilg_state = ?',
      [email, 'ACTIVE'],
    );

    if (!emp) {
      res.status(403).json({ error: 'No active employee record for this account' });
      return;
    }

    const sessionId = await createSession({
      empId:     emp.emp_id,
      email,
      role:      emp.role ?? 'EMPLOYEE',
      iss:       'zoho',
      sub,
      ttlHours:  config.session.ttlCorporateHours,
      ip:        req.ip ?? '',
      userAgent: req.get('user-agent') ?? '',
    });

    setSessionCookie(res, sessionId, config.session.ttlCorporateHours);
    const { returnTo } = parseOAuthState(req.query['state'] as string | undefined);
    res.redirect(returnTo === '/' ? '/login' : returnTo);
  } catch (err) {
    logger.error({ err }, 'Zoho OIDC callback failed');
    res.status(500).json({ error: 'Authentication failed' });
  }
}

// ---------------------------------------------------------------------------
// logoutHandler
// ---------------------------------------------------------------------------
export async function logoutHandler(req: Request, res: Response): Promise<void> {
  const cookieHeader = req.headers['cookie'] ?? '';
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));

  if (match) {
    const sessionId = verifySessionCookie(match[1]);
    if (sessionId) {
      // Mark revoked in DB
      await query(
        'UPDATE lilg_sessions SET revoked_at = UTC_TIMESTAMP() WHERE session_id = ?',
        [sessionId],
      ).catch((err) => logger.warn({ err }, 'Failed to revoke session in DB'));

      // Remove from Redis
      await redis.del(`${SESSION_REDIS_PREFIX}${sessionId}`).catch(() => {/* non-fatal */});
    }
  }

  res.clearCookie(COOKIE_NAME);

  const iss = req.user?.iss ?? 'local';
  if (iss === 'local') {
    res.json({ success: true, redirect: '/login' });
    return;
  }

  const endSessionUrl = iss === 'zoho'
    ? `https://accounts.zoho.in/oauth/v2/logout?redirect_uri=${encodeURIComponent(req.protocol + '://' + req.get('host') + '/')}`
    : `https://accounts.google.com/logout`;

  res.redirect(endSessionUrl);
}
