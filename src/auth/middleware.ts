/**
 * LILG Auth Middleware
 * --------------------
 * - HMAC-signed session cookies
 * - OIDC callback handler for Google
 * - Session lookup: Redis (hot) → DB (fallback)
 * - Logout with IDP end_session redirect
 */

import { Request, Response, NextFunction } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { getClientIp } from '../utils/request-context.js';
import { query, queryOne } from '../db/connection.js';
import { redis } from './session-store.js';
import logger from '../utils/logger.js';
import { parseOAuthState } from './login-routes.js';
import { redirectLoginAuthError } from './login-redirect.js';
import { getGoogleOidcConfig, isGoogleOidcConfigured } from './google-oidc-config.js';
import { getGoogleOAuthRedirectUri } from './google-oauth-redirect.js';
import { emailAllowedForGoogleDomains } from './google-domains.js';
import {
  COOKIE_NAME,
  SESSION_REDIS_PREFIX,
  verifySessionCookie,
  createSession,
  setSessionCookie,
  cacheSessionUser,
} from './session.js';
import { getSessionPolicy, getSessionCreateTtlHours } from '../services/session-policy.js';
import {
  MFA_CHALLENGE_PREFIX,
  MFA_CHALLENGE_TTL_S,
  MFA_ENROLL_CHALLENGE_PREFIX,
  getMfaRequirementContext,
  isMfaChallengeRequired,
  type MfaChallenge,
  type MfaEnrollChallenge,
} from './local-auth.js';
import { getMfaStatus, challengeMethodsFromStatus } from './mfa.js';
import {
  hasValidMfaDeviceTrust,
  setMfaDeviceTrustCookie,
} from './mfa-device-trust.js';
import { evaluateAdaptiveAuth } from '../services/adaptive-auth-engine.js';
import crypto from 'node:crypto';

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

// ---------------------------------------------------------------------------
// Cookie helpers — see session.ts
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Session cache helpers
// ---------------------------------------------------------------------------

async function getSessionFromRedis(sessionId: string): Promise<LilgUser | null> {
  const raw = await redis.get(`${SESSION_REDIS_PREFIX}${sessionId}`);
  if (!raw) return null;

  // Always re-check DB revocation / expiry — Redis alone can outlive an admin revoke
  // or a failed Redis DEL on logout.
  const live = await queryOne<{
    role: string;
    expires_at: Date;
    revoked_at: Date | null;
    created_at: Date;
    last_active_at: Date;
  }>(
    `SELECT role, expires_at, revoked_at, created_at, last_active_at
       FROM idp_sessions WHERE session_id = ?`,
    [sessionId],
  );
  if (!live || live.revoked_at !== null || new Date(live.expires_at) < new Date()) {
    await redis.del(`${SESSION_REDIS_PREFIX}${sessionId}`).catch(() => {/* non-fatal */});
    return null;
  }

  const timedOut = await enforceSessionTimeouts(sessionId, live.created_at, live.last_active_at);
  if (timedOut) return null;

  const u = JSON.parse(raw) as LilgUser;
  u.expiresAt = new Date(live.expires_at);
  // Prefer live role so demotions take effect without waiting for Redis TTL
  u.role = live.role;
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
    created_at: Date;
    last_active_at: Date;
  }>(
    `SELECT session_id, emp_id, email, role, iss, sub, expires_at, revoked_at,
            created_at, last_active_at
       FROM idp_sessions
      WHERE session_id = ?`,
    [sessionId],
  );

  if (!row || row.revoked_at !== null) return null;
  if (new Date(row.expires_at) < new Date()) return null;

  const timedOut = await enforceSessionTimeouts(sessionId, row.created_at, row.last_active_at);
  if (timedOut) return null;

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

/** Returns true if session was revoked due to idle or absolute timeout. */
async function enforceSessionTimeouts(
  sessionId: string,
  createdAt: Date,
  lastActiveAt: Date,
): Promise<boolean> {
  const policy = await getSessionPolicy();
  const now = Date.now();
  const createdMs = new Date(createdAt).getTime();
  const lastActiveMs = new Date(lastActiveAt).getTime();
  const absoluteDeadline = createdMs + policy.absoluteHours * 3600 * 1000;
  const idleDeadline = lastActiveMs + policy.idleHours * 3600 * 1000;

  if (now <= absoluteDeadline && now <= idleDeadline) return false;

  const reason = now > absoluteDeadline ? 'ABSOLUTE_TIMEOUT' : 'IDLE_TIMEOUT';
  await query(
    `UPDATE idp_sessions
        SET revoked_at = UTC_TIMESTAMP(), expires_at = UTC_TIMESTAMP()
      WHERE session_id = ? AND revoked_at IS NULL`,
    [sessionId],
  ).catch((err) => logger.warn({ err, sessionId, reason }, 'Failed to revoke timed-out session'));
  await redis.del(`${SESSION_REDIS_PREFIX}${sessionId}`).catch(() => {/* non-fatal */});
  logger.info({ sessionId, reason, idleHours: policy.idleHours, absoluteHours: policy.absoluteHours }, 'Session auto-timeout');
  return true;
}

/** Resolve portal session from cookie without sending a response (null if absent/invalid).
 *  Pass `res` to refresh the sliding cookie maxAge (SAML/OIDC HTML flows). */
export async function resolveSession(req: Request, res?: Response): Promise<LilgUser | null> {
  const cookieHeader = req.headers['cookie'] ?? '';
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  if (!match) return null;

  const sessionId = verifySessionCookie(match[1]!);
  if (!sessionId) return null;

  let user = await getSessionFromRedis(sessionId);
  if (!user) {
    user = await getSessionFromDb(sessionId);
  }
  if (!user) return null;

  // Sliding idle window: refresh last_active + expires_at (capped by absolute)
  const policy = await getSessionPolicy();
  const row = await queryOne<{ created_at: Date }>(
    `SELECT created_at FROM idp_sessions WHERE session_id = ?`,
    [sessionId],
  );
  if (row) {
    const createdMs = new Date(row.created_at).getTime();
    const absoluteDeadline = createdMs + policy.absoluteHours * 3600 * 1000;
    const slidExpires = Math.min(Date.now() + policy.idleHours * 3600 * 1000, absoluteDeadline);
    const expiresAt = new Date(slidExpires);
    const expiresSql = expiresAt.toISOString().slice(0, 19).replace('T', ' ');
    void query(
      `UPDATE idp_sessions
          SET last_active_at = UTC_TIMESTAMP(), expires_at = ?
        WHERE session_id = ? AND revoked_at IS NULL`,
      [expiresSql, sessionId],
    ).catch((err) => logger.warn({ err }, 'Failed to slide session expiry'));
    user.expiresAt = expiresAt;
    void cacheSessionUser(user).catch(() => {/* non-fatal */});
  } else {
    void query(
      'UPDATE idp_sessions SET last_active_at = UTC_TIMESTAMP() WHERE session_id = ?',
      [sessionId],
    ).catch((err) => logger.warn({ err }, 'Failed to update last_active_at'));
  }

  if (res) {
    const remainingMs = user.expiresAt.getTime() - Date.now();
    if (remainingMs > 0) {
      setSessionCookie(res, user.sessionId, remainingMs / 3600_000);
    }
  }

  return user;
}

// ---------------------------------------------------------------------------
// requireAuth middleware
// ---------------------------------------------------------------------------
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  void (async () => {
    const user = await resolveSession(req, res);
    if (!user) {
      const cookieHeader = req.headers['cookie'] ?? '';
      const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
      if (!match) {
        res.status(401).json({ error: 'Unauthenticated', code: 'NO_SESSION' });
        return;
      }
      const sessionId = verifySessionCookie(match[1]!);
      if (!sessionId) {
        res.status(401).json({ error: 'Invalid session cookie', code: 'BAD_SIGNATURE' });
        return;
      }
      res.clearCookie(COOKIE_NAME);
      res.status(401).json({ error: 'Session expired or revoked', code: 'SESSION_EXPIRED' });
      return;
    }

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
  const { returnTo, redirectUri: stateRedirectUri } = parseOAuthState(
    req.query['state'] as string | undefined,
  );

  const googleOAuthError = req.query['error'] as string | undefined;
  if (googleOAuthError) {
    const desc = String(req.query['error_description'] ?? googleOAuthError).slice(0, 80);
    logger.warn({ googleOAuthError, desc, returnTo }, 'Google OAuth returned error to callback');
    redirectLoginAuthError(
      res,
      googleOAuthError === 'access_denied' ? 'google_access_denied' : 'google_oauth_error',
      returnTo,
      desc,
    );
    return;
  }

  const code = req.query['code'] as string | undefined;
  if (!code) {
    redirectLoginAuthError(res, 'missing_code', returnTo);
    return;
  }

  try {
    const oidc = await Promise.race([
      getGoogleOidcConfig(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('google oidc config timeout')), 5_000);
      }),
    ]);
    if (!isGoogleOidcConfigured(oidc)) {
      redirectLoginAuthError(res, 'google_not_configured', returnTo);
      return;
    }

    // Must match authorize redirect_uri exactly (prefer value from OAuth state)
    const redirectUri = stateRedirectUri || getGoogleOAuthRedirectUri(req);

    // Exchange code for tokens
    const tokenRes = await (await import('axios')).default.post<{
      id_token: string;
      access_token: string;
      expires_in: number;
    }>(
      'https://oauth2.googleapis.com/token',
      new URLSearchParams({
        code,
        client_id:     oidc.clientId,
        client_secret: oidc.clientSecret,
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code',
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10_000 },
    );

    const { id_token } = tokenRes.data;

    // Verify id_token (bound JWKS fetch — createRemoteJWKSet can hang without a budget)
    const { payload } = await Promise.race([
      jwtVerify(id_token, googleJwks, {
        issuer:   ['accounts.google.com', 'https://accounts.google.com'],
        audience: oidc.clientId,
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('google id_token verify timeout')), 10_000);
      }),
    ]);

    const hd = typeof payload['hd'] === 'string' ? payload['hd'].trim().toLowerCase() : '';
    if (hd && !oidc.hostedDomains.includes(hd)) {
      redirectLoginAuthError(res, 'wrong_hosted_domain', returnTo, hd);
      return;
    }

    const email = String(payload['email'] ?? '').trim().toLowerCase();
    if (!emailAllowedForGoogleDomains(email, oidc.hostedDomains)) {
      redirectLoginAuthError(res, 'domain_not_permitted', returnTo, email.split('@')[1]);
      return;
    }
    if (!payload['email_verified']) {
      redirectLoginAuthError(res, 'email_not_verified', returnTo);
      return;
    }

    const sub   = payload['sub'] as string;

    // Lookup employee by corporate email (case-insensitive)
    const emp = await queryOne<{ emp_id: string; role: string }>(
      `SELECT emp_id, role FROM employees
        WHERE LOWER(email_corp) = ? AND ilg_state IN ('ACTIVE', 'REACTIVATED')`,
      [email],
    );

    if (!emp) {
      logger.warn({ email }, 'Google login: no active employee record');
      redirectLoginAuthError(res, 'no_employee_record', returnTo);
      return;
    }

    const portalAccount = await queryOne<{ id: number; role: string }>(
      `SELECT id, role FROM local_accounts
        WHERE emp_id = ? AND active = 1
          AND role IN ('ADMIN','SUPER_ADMIN','APP_CONTRIBUTOR','USER_GROUP_MANAGER','CUSTOM')`,
      [emp.emp_id],
    );
    const sessionRole = portalAccount?.role ?? 'EMPLOYEE';
    const ip = getClientIp(req);
    const userAgent = req.get('user-agent') ?? '';

    // Same MFA + adaptive gates as local password login
    const [mfa, adaptive, mfaRequirements] = await Promise.all([
      getMfaStatus(emp.emp_id),
      evaluateAdaptiveAuth({
        ip,
        email,
        userAgent,
        role: sessionRole,
        empId: emp.emp_id,
      }),
      getMfaRequirementContext(emp.emp_id),
    ]);

    if (adaptive.action === 'BLOCK') {
      logger.warn({ empId: emp.emp_id, ip, signals: adaptive.signals }, 'Google login blocked by adaptive auth');
      redirectLoginAuthError(res, 'adaptive_blocked', returnTo);
      return;
    }

    const riskForcesMfa = adaptive.action === 'MFA' || adaptive.action === 'STEP_UP';
    const deviceTrusted = mfa.enabled
      && mfaRequirements.rememberDeviceHours > 0
      && hasValidMfaDeviceTrust(req, emp.emp_id);
    const mfaRequired = isMfaChallengeRequired({
      mfaEnabled: mfa.enabled,
      riskForcesMfa,
      deviceTrusted,
      role: sessionRole,
      requirements: mfaRequirements,
    });

    if (mfaRequired) {
      if (!mfa.enabled) {
        const enrollChallengeId = crypto.randomUUID();
        const enrollChallenge: MfaEnrollChallenge = {
          empId:     emp.emp_id,
          email,
          role:      sessionRole,
          accountId: portalAccount?.id ?? 0,
          createdAt: Date.now(),
          iss:       'google',
          sub,
          returnTo,
        };
        await redis.set(
          `${MFA_ENROLL_CHALLENGE_PREFIX}${enrollChallengeId}`,
          JSON.stringify(enrollChallenge),
          'EX',
          MFA_CHALLENGE_TTL_S,
        );
        const params = new URLSearchParams({
          enroll_challenge: enrollChallengeId,
          email,
          return_to: returnTo,
        });
        res.redirect(`/login?${params.toString()}`);
        return;
      }

      const challengeId = crypto.randomUUID();
      const challenge: MfaChallenge = {
        empId:     emp.emp_id,
        email,
        role:      sessionRole,
        accountId: portalAccount?.id ?? 0,
        createdAt: Date.now(),
        stepUp:    adaptive.action === 'STEP_UP',
        iss:       'google',
        sub,
        returnTo,
      };
      await redis.set(
        `${MFA_CHALLENGE_PREFIX}${challengeId}`,
        JSON.stringify(challenge),
        'EX',
        MFA_CHALLENGE_TTL_S,
      );
      const availableMethods = challengeMethodsFromStatus(mfa);
      const params = new URLSearchParams({
        mfa_challenge: challengeId,
        email,
        return_to: returnTo,
        returnTo,
        mfa_methods: availableMethods.join(','),
      });
      res.redirect(`/login?${params.toString()}`);
      return;
    }

    const ttlHours = await getSessionCreateTtlHours();
    const sessionId = await createSession({
      empId:     emp.emp_id,
      email,
      role:      sessionRole,
      iss:       'google',
      sub,
      ttlHours,
      ip,
      userAgent,
    });

    setSessionCookie(res, sessionId, ttlHours);
    if (deviceTrusted && mfaRequirements.rememberDeviceHours > 0) {
      setMfaDeviceTrustCookie(res, emp.emp_id, mfaRequirements.rememberDeviceHours, userAgent);
    }
    res.redirect(returnTo);
  } catch (err) {
    const axiosData = (err as { response?: { data?: { error?: string; error_description?: string } } })
      ?.response?.data;
    const oauthErr = axiosData?.error;
    const oauthDesc = axiosData?.error_description;
    logger.error(
      { err, oauthErr, oauthDesc, returnTo },
      'Google OIDC callback failed',
    );
    if (
      oauthErr === 'invalid_client'
      || oauthErr === 'unauthorized_client'
      || oauthErr === 'redirect_uri_mismatch'
      || oauthErr === 'invalid_grant'
    ) {
      redirectLoginAuthError(res, 'google_oauth_error', returnTo, oauthErr);
      return;
    }
    redirectLoginAuthError(res, 'auth_failed', returnTo, oauthErr || undefined);
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
        'UPDATE idp_sessions SET revoked_at = UTC_TIMESTAMP() WHERE session_id = ?',
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

  const endSessionUrl = `https://accounts.google.com/logout`;

  res.redirect(endSessionUrl);
}
