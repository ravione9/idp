/**
 * Local email + password login for administrators.
 *
 * Two-step flow:
 *   1. POST /auth/local/login            { email, password }
 *        → { success, redirect }               (low risk, no MFA)
 *        → { mfaRequired:true, challengeId }   (MFA required by policy or enrollment)
 *        → HTTP 403 ADAPTIVE_BLOCKED           (policy says BLOCK)
 *        → { enrollRequired:true, enrollChallengeId } (policy demands MFA but user not enrolled)
 *   2. POST /auth/local/login/mfa-verify { challengeId, code }
 *        → { success:true, redirect:'/' }
 *   2b. POST /auth/local/login/mfa-enroll { enrollChallengeId }
 *        → { secret, qrDataUrl }  (start TOTP setup without a session)
 *   2c. POST /auth/local/login/mfa-enroll/confirm { enrollChallengeId, code }
 *        → { success:true, redirect:'/', backupCodes }  (enable MFA + session)
 *   2d. POST /auth/local/login/mfa-enroll/defer { enrollChallengeId }
 *        → { deferred:true, session:false } OR { success:true, redirect } during grace period
 */
import { Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import qrcode from 'qrcode';
import logger from '../utils/logger.js';
import { createSession, setSessionCookie } from './session.js';
import { getSessionCreateTtlHours } from '../services/session-policy.js';
import { redis } from './session-store.js';
import { confirmEnrollment, challengeMethodsFromStatus, getMfaStatus, startEnrollment, verifyAnyMfaCode } from './mfa.js';
import { sendEmailOtp, sendSmsOtp } from './mfa-otp.js';
import {
  hasValidMfaDeviceTrust,
  setMfaDeviceTrustCookie,
} from './mfa-device-trust.js';
import {
  getWebAuthnAuthenticationOptions,
  resolveWebAuthnOrigin,
  verifyWebAuthnAuthentication,
} from './mfa-webauthn.js';
import { isUserInEnforcedMfaGroup } from './mfa-methods.js';
import { query, queryOne } from '../db/connection.js';
import {
  ensureMasterAdminFromEnv,
  findLocalAccountByEmail,
  isMasterAdminCredentials,
  touchLocalLogin,
  verifyLocalPassword,
} from '../services/local-admin.js';
import { authenticateAdCorporateUser } from '../services/ad-auth.js';
import { getClientIp } from '../utils/request-context.js';
import { evaluateAdaptiveAuth } from '../services/adaptive-auth-engine.js';
import { isPortalAccessible } from '../fsm/states.js';
import { PORTAL_OPERATOR_ROLES } from '../services/portal-roles.js';
import { markSessionMfaFresh } from '../services/app-mfa-stepup.js';

export const MFA_CHALLENGE_PREFIX        = 'lilg:mfa-challenge:';
export const MFA_ENROLL_CHALLENGE_PREFIX = 'lilg:mfa-enroll-challenge:';
const MFA_GRACE_PREFIX            = 'lilg:mfa-grace:';
export const MFA_CHALLENGE_TTL_S         = 600; // 10 min — SSO app login often pauses on authenticator

const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(8),
  /** Safe relative path so MFA/session can continue to SAML resume / app launch. */
  returnTo: z.string().max(500).optional(),
});

/** Allow spaced paste ("123 456"); normalize before verify. */
const mfaCodeSchema = z.string().min(6).max(16).transform((raw) => raw.replace(/\s+/g, '').trim());

const verifySchema = z.object({
  challengeId: z.string().uuid(),
  code:        mfaCodeSchema,
});

const enrollChallengeSchema = z.object({
  enrollChallengeId: z.string().uuid(),
});

const enrollConfirmSchema = z.object({
  enrollChallengeId: z.string().uuid(),
  code:              mfaCodeSchema,
});

export function safeChallengeReturnTo(raw: string | undefined): string | undefined {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return undefined;
  return raw.slice(0, 500);
}

export interface MfaChallenge {
  empId:     string;
  email:     string;
  role:      string;
  accountId: number;
  createdAt: number;
  /** True when the adaptive engine returned STEP_UP (MFA + manager-approval hint). */
  stepUp?:   boolean;
  /** Auth issuer — google challenges skip local account touch. */
  iss?:      'local' | 'google';
  sub?:      string;
  returnTo?: string;
  /**
   * Critical-app / session step-up: user already has a portal session.
   * On verify, refresh MFA freshness on this session instead of minting a new one.
   */
  sessionStepUp?: boolean;
  sessionId?:     string;
}

export interface MfaEnrollChallenge {
  empId:     string;
  email:     string;
  role:      string;
  accountId: number;
  createdAt: number;
  iss?:      'local' | 'google';
  sub?:      string;
  returnTo?: string;
}

interface MfaPolicyRow {
  policy_key: string;
  policy_value: string;
}

interface MfaRequirementContext {
  userEnforced: boolean;
  globalEnforce: boolean;
  enforceForAdmins: boolean;
  userInExcludedGroup: boolean;
  groupEnforce: boolean;
  gracePeriodHours: number;
  /** Skip MFA on this browser after a successful challenge (0 = always prompt). */
  rememberDeviceHours: number;
}

/** Any console operator role is subject to enforce_for_admins MFA policy. */
const ADMIN_MFA_ROLES = PORTAL_OPERATOR_ROLES;

function parsePolicyBoolean(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (!trimmed) return fallback;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'boolean') return parsed;
    if (typeof parsed === 'number') return parsed !== 0;
  } catch {
    // Keep fallback parsing below.
  }

  const normalized = trimmed.toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return fallback;
}

function parsePolicyNumber(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && !Number.isNaN(raw)) return raw;
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'number' && !Number.isNaN(parsed)) return parsed;
  } catch {
    // Keep fallback parsing below.
  }
  const n = parseInt(trimmed, 10);
  return Number.isNaN(n) ? fallback : n;
}

function parsePolicyStringArray(raw: unknown): string[] {
  const normalize = (arr: unknown[]): string[] => arr
    .map((v) => String(v ?? '').trim())
    .filter((v) => v.length > 0);

  if (Array.isArray(raw)) return normalize(raw);
  if (typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return normalize(parsed);
  } catch {
    // Fallback to comma-separated values.
  }
  return normalize(trimmed.split(','));
}

export async function getMfaRequirementContext(empId: string): Promise<MfaRequirementContext> {
  const employeeRowsPromise = query<{ mfa_enforced: number }>(
    'SELECT mfa_enforced FROM employees WHERE emp_id = ? LIMIT 1',
    [empId],
  );
  const policyRowsPromise = query<MfaPolicyRow>(
    `SELECT policy_key, policy_value
       FROM mfa_policy
      WHERE policy_key IN (
        'global_enforce', 'enforce_for_admins', 'excluded_group_ids',
        'grace_period_hours', 'remember_device_hours'
      )`,
    [],
  ).catch((err) => {
    logger.warn({ empId, err }, 'mfa_policy query failed');
    return [] as MfaPolicyRow[];
  });

  const [employeeRows, policyRows, groupEnforce] = await Promise.all([
    employeeRowsPromise,
    policyRowsPromise,
    isUserInEnforcedMfaGroup(empId),
  ]);

  const policyMap = new Map(policyRows.map((row) => [row.policy_key, row.policy_value]));
  const globalEnforce = parsePolicyBoolean(policyMap.get('global_enforce'), false);
  // Default off — admin MFA is opt-in via Strong Auth policy, not auto-enforced.
  const enforceForAdmins = parsePolicyBoolean(policyMap.get('enforce_for_admins'), false);
  const userEnforced = (employeeRows[0]?.mfa_enforced ?? 0) === 1;
  const excludedGroupIds = parsePolicyStringArray(policyMap.get('excluded_group_ids'));

  let userInExcludedGroup = false;
  if (excludedGroupIds.length > 0) {
    const placeholders = excludedGroupIds.map(() => '?').join(', ');
    const membership = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n
         FROM group_members gm
        WHERE gm.emp_id = ?
          AND gm.group_id IN (${placeholders})`,
      [empId, ...excludedGroupIds],
    ).catch((err) => {
      logger.warn({ empId, err }, 'group exclusion lookup failed');
      return null;
    });
    userInExcludedGroup = Number(membership?.n ?? 0) > 0;
  }

  const gracePeriodHours = Math.max(
    0,
    parsePolicyNumber(policyMap.get('grace_period_hours'), 24),
  );
  const rememberDeviceHours = Math.max(
    0,
    Math.min(8760, parsePolicyNumber(policyMap.get('remember_device_hours'), 24)),
  );

  return {
    userEnforced,
    globalEnforce,
    enforceForAdmins,
    userInExcludedGroup,
    groupEnforce,
    gracePeriodHours,
    rememberDeviceHours,
  };
}

/**
 * Decide whether login must present an MFA challenge.
 *
 * Excluded groups override global/admin enforcement — including challenges that
 * would otherwise fire only because the user already enrolled under that policy.
 * Per-user enforce, group-policy enforce, and adaptive risk still require MFA.
 */
export function isMfaChallengeRequired(opts: {
  mfaEnabled: boolean;
  riskForcesMfa: boolean;
  deviceTrusted: boolean;
  role: string;
  requirements: MfaRequirementContext;
}): boolean {
  const { mfaEnabled, riskForcesMfa, deviceTrusted, role, requirements } = opts;
  if (riskForcesMfa) return true;

  const adminRole = ADMIN_MFA_ROLES.has((role || '').toUpperCase());
  const policyRequiresMfa =
    requirements.userEnforced
    || requirements.groupEnforce
    || (
      !requirements.userInExcludedGroup
      && (requirements.globalEnforce || (requirements.enforceForAdmins && adminRole))
    );

  // Excluded from policy MFA: do not challenge solely due to existing enrollment
  // (often forced earlier by global_enforce). Explicit enforce flags still apply.
  const challengeBecauseEnrolled = mfaEnabled && !requirements.userInExcludedGroup;

  const enrolledOrPolicy = challengeBecauseEnrolled || policyRequiresMfa;
  return enrolledOrPolicy && !deviceTrusted;
}

function mfaGraceKey(empId: string): string {
  return `${MFA_GRACE_PREFIX}${empId}`;
}

async function ensureMfaGraceStarted(empId: string, gracePeriodHours: number): Promise<void> {
  if (gracePeriodHours <= 0) return;
  const ttlS = Math.max(gracePeriodHours * 3600, 3600);
  await redis.set(mfaGraceKey(empId), String(Date.now()), 'EX', ttlS, 'NX');
}

async function getGraceRemainingMs(empId: string, gracePeriodHours: number): Promise<number> {
  if (gracePeriodHours <= 0) return 0;
  const raw = await redis.get(mfaGraceKey(empId));
  if (!raw) return 0;
  const startedAt = Number(raw);
  if (Number.isNaN(startedAt)) return 0;
  const remaining = startedAt + gracePeriodHours * 3600 * 1000 - Date.now();
  return remaining > 0 ? remaining : 0;
}

async function clearMfaGrace(empId: string): Promise<void> {
  await redis.del(mfaGraceKey(empId));
}

async function logAttempt(email: string, ip: string, success: boolean, reason?: string): Promise<void> {
  try {
    await query(
      `INSERT INTO auth_attempts (email, ip, success, reason) VALUES (?, ?, ?, ?)`,
      [email, ip || null, success ? 1 : 0, reason ?? null],
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to log auth attempt');
  }
}

async function issueSessionAndRespond(
  res:     Response,
  req:     Request,
  account: { id: number; emp_id: string; email: string; role: string },
  opts?: {
    iss?: 'local' | 'google';
    sub?: string;
    returnTo?: string;
    /** Set/refresh MFA remember-device cookie when hours > 0. */
    rememberDeviceHours?: number;
    /** True when this session follows a successful MFA challenge (critical-app freshness). */
    mfaVerified?: boolean;
  },
): Promise<void> {
  const iss = opts?.iss ?? 'local';
  const sub = opts?.sub ?? `local:${account.id}`;
  const userAgent = req.get('user-agent') ?? '';
  const ttlHours = await getSessionCreateTtlHours();
  const sessionId = await createSession({
    empId:     account.emp_id,
    email:     account.email,
    role:      account.role,
    iss,
    sub,
    ttlHours,
    ip:        getClientIp(req),
    userAgent,
  });

  if (iss === 'local' && account.id > 0) {
    await touchLocalLogin(account.id);
  }
  setSessionCookie(res, sessionId, ttlHours);
  if ((opts?.rememberDeviceHours ?? 0) > 0) {
    setMfaDeviceTrustCookie(res, account.emp_id, opts!.rememberDeviceHours!, userAgent);
  }
  if (opts?.mfaVerified) {
    await markSessionMfaFresh(sessionId);
  }
  logger.info({ empId: account.emp_id, email: account.email, iss }, 'Login session issued');
  res.json({ success: true, redirect: opts?.returnTo || '/' });
}

/** Complete MFA for an existing session (critical app step-up) or mint a new session. */
async function finishMfaChallenge(
  req: Request,
  res: Response,
  challenge: MfaChallenge,
): Promise<void> {
  const mfaRequirements = await getMfaRequirementContext(challenge.empId);
  const userAgent = req.get('user-agent') ?? '';

  if (challenge.sessionStepUp && challenge.sessionId) {
    await markSessionMfaFresh(challenge.sessionId);
    if (mfaRequirements.rememberDeviceHours > 0) {
      setMfaDeviceTrustCookie(res, challenge.empId, mfaRequirements.rememberDeviceHours, userAgent);
    }
    logger.info({ empId: challenge.empId, sessionId: challenge.sessionId }, 'Critical-app MFA step-up OK');
    res.json({ success: true, redirect: challenge.returnTo || '/', appStepUp: true });
    return;
  }

  const sessionOpts: {
    iss?: 'local' | 'google';
    sub?: string;
    returnTo?: string;
    rememberDeviceHours?: number;
    mfaVerified?: boolean;
  } = {
    iss: challenge.iss ?? 'local',
    rememberDeviceHours: mfaRequirements.rememberDeviceHours,
    mfaVerified: true,
  };
  if (challenge.sub) sessionOpts.sub = challenge.sub;
  if (challenge.returnTo) sessionOpts.returnTo = challenge.returnTo;
  await issueSessionAndRespond(res, req, {
    id:     challenge.accountId,
    emp_id: challenge.empId,
    email:  challenge.email,
    role:   challenge.role,
  }, sessionOpts);
}

export async function localLoginHandler(req: Request, res: Response): Promise<void> {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid email or password format' });
    return;
  }

  const { email, password } = parsed.data;
  const ip = getClientIp(req);

  try {
    let account = await findLocalAccountByEmail(email);

    if (!account && isMasterAdminCredentials(email, password)) {
      await ensureMasterAdminFromEnv();
      account = await findLocalAccountByEmail(email);
    }

    if (!account) {
      // No local account at all — try AD corporate auth.
      account = await authenticateAdCorporateUser(email, password);
      if (!account) {
        await logAttempt(email, ip, false, 'no-such-account');
        res.status(401).json({ error: 'Invalid email or password' });
        return;
      }
      // AD auth succeeded and stored a fresh hash — fall through to session.
    } else {
      // Local account found — verify password.
      // If it fails, the local hash may be stale (AD password changed since last sync/login).
      // Try AD before rejecting.
      const valid = await verifyLocalPassword(password, account.password_hash);
      if (!valid) {
        const adAccount = await authenticateAdCorporateUser(email, password);
        if (!adAccount) {
          await logAttempt(email, ip, false, 'bad-password');
          res.status(401).json({ error: 'Invalid email or password' });
          return;
        }
        account = adAccount; // refreshed account with updated hash
      }
    }

    if (!isPortalAccessible(account.ilg_state)) {
      await logAttempt(email, ip, false, `account-suspended:${account.ilg_state}`);
      res.status(403).json({ error: 'Account is suspended', code: 'ACCOUNT_SUSPENDED' });
      return;
    }

    // ── Adaptive auth evaluation (risk engine) ───────────────────────────────
    const [mfa, adaptive, mfaRequirements] = await Promise.all([
      getMfaStatus(account.emp_id),
      evaluateAdaptiveAuth({
        ip,
        email:     account.email,
        userAgent: req.get('user-agent') ?? '',
        role:      account.role,
        empId:     account.emp_id,
      }),
      getMfaRequirementContext(account.emp_id),
    ]);

    if (adaptive.action === 'BLOCK') {
      await logAttempt(email, ip, false, `adaptive-blocked:${adaptive.signals.slice(0, 3).join(',')}`);
      logger.warn({ empId: account.emp_id, ip, signals: adaptive.signals }, 'Login blocked by adaptive auth');
      res.status(403).json({ error: 'Access blocked by security policy', code: 'ADAPTIVE_BLOCKED' });
      return;
    }

    // MFA is required when:
    //   • adaptive engine returned MFA or STEP_UP (always — risk overrides trust), or
    //   • user has MFA enrolled / policy requires MFA, unless this browser still has
    //     a valid remember-device trust cookie (mfa_policy.remember_device_hours).
    // Excluded groups override global/admin policy (including enrolled-only challenges).
    const riskForcesMfa = adaptive.action === 'MFA' || adaptive.action === 'STEP_UP';
    const deviceTrusted = mfa.enabled
      && mfaRequirements.rememberDeviceHours > 0
      && hasValidMfaDeviceTrust(req, account.emp_id);
    const mfaRequired = isMfaChallengeRequired({
      mfaEnabled: mfa.enabled,
      riskForcesMfa,
      deviceTrusted,
      role: account.role,
      requirements: mfaRequirements,
    });

    if (mfaRequired) {
      if (!mfa.enabled) {
        const enrollChallengeId = crypto.randomUUID();
        const enrollReturnTo = safeChallengeReturnTo(parsed.data.returnTo);
        const enrollChallenge: MfaEnrollChallenge = {
          empId:     account.emp_id,
          email:     account.email,
          role:      account.role,
          accountId: account.id,
          createdAt: Date.now(),
          ...(enrollReturnTo ? { returnTo: enrollReturnTo } : {}),
        };
        await redis.set(
          `${MFA_ENROLL_CHALLENGE_PREFIX}${enrollChallengeId}`,
          JSON.stringify(enrollChallenge),
          'EX',
          MFA_CHALLENGE_TTL_S,
        );
        await ensureMfaGraceStarted(account.emp_id, mfaRequirements.gracePeriodHours);
        const graceRemainingMs = await getGraceRemainingMs(account.emp_id, mfaRequirements.gracePeriodHours);
        await logAttempt(email, ip, true, 'password-ok-mfa-enroll-pending');
        res.json({
          enrollRequired: true,
          enrollChallengeId,
          gracePeriodHours: mfaRequirements.gracePeriodHours,
          graceActive: graceRemainingMs > 0,
        });
        return;
      }

      const challengeId = crypto.randomUUID();
      const returnTo = safeChallengeReturnTo(parsed.data.returnTo);
      const challenge: MfaChallenge = {
        empId:     account.emp_id,
        email:     account.email,
        role:      account.role,
        accountId: account.id,
        createdAt: Date.now(),
        stepUp:    adaptive.action === 'STEP_UP',
        ...(returnTo ? { returnTo } : {}),
      };
      await redis.set(
        `${MFA_CHALLENGE_PREFIX}${challengeId}`,
        JSON.stringify(challenge),
        'EX',
        MFA_CHALLENGE_TTL_S,
      );
      await logAttempt(email, ip, true, `password-ok-mfa-pending${challenge.stepUp ? '-stepup' : ''}`);
      const mfaState = await getMfaStatus(account.emp_id);
      res.json({
        mfaRequired: true,
        challengeId,
        stepUp: challenge.stepUp ?? false,
        availableMethods: challengeMethodsFromStatus(mfaState),
      });
      return;
    }

    await logAttempt(email, ip, true, deviceTrusted ? 'password-ok-mfa-trusted-device' : undefined);
    await issueSessionAndRespond(res, req, account, {
      rememberDeviceHours: deviceTrusted ? mfaRequirements.rememberDeviceHours : 0,
    });
  } catch (err) {
    logger.error({ err }, 'Local login failed');
    res.status(500).json({ error: 'Login failed' });
  }
}

export async function localLoginMfaVerifyHandler(req: Request, res: Response): Promise<void> {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid verification request' });
    return;
  }

  const key = `${MFA_CHALLENGE_PREFIX}${parsed.data.challengeId}`;
  const raw = await redis.get(key);
  if (!raw) {
    res.status(401).json({ error: 'Challenge expired — sign in again' });
    return;
  }

  const challenge = JSON.parse(raw) as MfaChallenge;
  const code = parsed.data.code;
  if (code.length < 6 || code.length > 8) {
    res.status(400).json({ error: 'Enter a 6-digit authenticator code (or 8-character backup code)' });
    return;
  }
  const ok = await verifyAnyMfaCode(challenge.empId, code);
  if (!ok) {
    await logAttempt(challenge.email, getClientIp(req), false, 'mfa-bad-code');
    res.status(401).json({ error: 'Invalid or expired verification code — try the next code from your app' });
    return;
  }

  await redis.del(key);
  await logAttempt(challenge.email, getClientIp(req), true, 'mfa-ok');
  await finishMfaChallenge(req, res, challenge);
}

async function loadEnrollChallenge(enrollChallengeId: string): Promise<MfaEnrollChallenge | null> {
  const raw = await redis.get(`${MFA_ENROLL_CHALLENGE_PREFIX}${enrollChallengeId}`);
  if (!raw) return null;
  return JSON.parse(raw) as MfaEnrollChallenge;
}

export async function localLoginMfaEnrollHandler(req: Request, res: Response): Promise<void> {
  const parsed = enrollChallengeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid enrollment request' });
    return;
  }

  const challenge = await loadEnrollChallenge(parsed.data.enrollChallengeId);
  if (!challenge) {
    res.status(401).json({ error: 'Enrollment session expired — sign in again' });
    return;
  }

  try {
    const result = await startEnrollment(challenge.empId, challenge.email);
    const qrDataUrl = await qrcode.toDataURL(result.otpauthUrl, { margin: 1, width: 220 });
    res.json({
      secret:     result.secret,
      otpauthUrl: result.otpauthUrl,
      qrDataUrl,
    });
  } catch (err) {
    logger.error({ err, empId: challenge.empId }, 'Login-time MFA enrollment start failed');
    res.status(500).json({ error: 'Could not start MFA enrollment' });
  }
}

export async function localLoginMfaEnrollConfirmHandler(req: Request, res: Response): Promise<void> {
  const parsed = enrollConfirmSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid enrollment confirmation' });
    return;
  }

  const key = `${MFA_ENROLL_CHALLENGE_PREFIX}${parsed.data.enrollChallengeId}`;
  const challenge = await loadEnrollChallenge(parsed.data.enrollChallengeId);
  if (!challenge) {
    res.status(401).json({ error: 'Enrollment session expired — sign in again' });
    return;
  }

  try {
    const { backupCodes } = await confirmEnrollment(challenge.empId, parsed.data.code);
    await redis.del(key);
    await clearMfaGrace(challenge.empId);
    await logAttempt(challenge.email, getClientIp(req), true, 'mfa-enroll-ok');

    const iss = challenge.iss ?? 'local';
    const sub = challenge.sub ?? `local:${challenge.accountId}`;
    const userAgent = req.get('user-agent') ?? '';
    const ttlHours = await getSessionCreateTtlHours();
    const sessionId = await createSession({
      empId:     challenge.empId,
      email:     challenge.email,
      role:      challenge.role,
      iss,
      sub,
      ttlHours,
      ip:        getClientIp(req),
      userAgent,
    });

    if (iss === 'local' && challenge.accountId > 0) {
      await touchLocalLogin(challenge.accountId);
    }
    setSessionCookie(res, sessionId, ttlHours);
    await markSessionMfaFresh(sessionId);
    const mfaRequirements = await getMfaRequirementContext(challenge.empId);
    if (mfaRequirements.rememberDeviceHours > 0) {
      setMfaDeviceTrustCookie(res, challenge.empId, mfaRequirements.rememberDeviceHours, userAgent);
    }
    logger.info({ empId: challenge.empId, email: challenge.email, iss }, 'Login after MFA enrollment');
    res.json({ success: true, redirect: challenge.returnTo || '/', backupCodes });
  } catch (err) {
    await logAttempt(challenge.email, getClientIp(req), false, 'mfa-enroll-bad-code');
    res.status(400).json({ error: err instanceof Error ? err.message : 'Verification failed' });
  }
}

export async function localLoginMfaEnrollDeferHandler(req: Request, res: Response): Promise<void> {
  const parsed = enrollChallengeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid defer request' });
    return;
  }

  const enrollChallengeId = parsed.data.enrollChallengeId;
  const key = `${MFA_ENROLL_CHALLENGE_PREFIX}${enrollChallengeId}`;
  const challenge = await loadEnrollChallenge(enrollChallengeId);
  if (!challenge) {
    res.status(401).json({ error: 'Enrollment session expired — sign in again' });
    return;
  }

  const mfaRequirements = await getMfaRequirementContext(challenge.empId);
  const graceRemainingMs = await getGraceRemainingMs(challenge.empId, mfaRequirements.gracePeriodHours);
  await redis.del(key);

  // Administrators follow the same grace/defer path as everyone else.
  // Whether MFA is required at all is decided by mfa_policy (enforce_for_admins,
  // global_enforce, per-user / group enforce) — not a hard-coded operator rule.

  if (graceRemainingMs > 0) {
    await logAttempt(challenge.email, getClientIp(req), true, 'mfa-enroll-deferred-grace');
    const ttlHours = await getSessionCreateTtlHours();
    const sessionId = await createSession({
      empId:     challenge.empId,
      email:     challenge.email,
      role:      challenge.role,
      iss:       'local',
      sub:       `local:${challenge.accountId}`,
      ttlHours,
      ip:        getClientIp(req),
      userAgent: req.get('user-agent') ?? '',
    });
    await touchLocalLogin(challenge.accountId);
    setSessionCookie(res, sessionId, ttlHours);
    logger.info({ empId: challenge.empId, email: challenge.email }, 'Local login with deferred MFA enrollment');
    res.json({
      success: true,
      redirect: '/',
      deferredEnrollment: true,
      graceRemainingHours: Math.ceil(graceRemainingMs / 3_600_000),
    });
    return;
  }

  await logAttempt(challenge.email, getClientIp(req), false, 'mfa-enroll-deferred');
  res.json({
    deferred: true,
    session: false,
    message: 'Two-factor setup is required. You can complete it on your next sign-in.',
  });
}

const mfaSendOtpSchema = z.object({
  challengeId: z.string().uuid(),
  channel:     z.enum(['email_otp', 'sms_otp']),
});

export async function localLoginMfaSendOtpHandler(req: Request, res: Response): Promise<void> {
  const parsed = mfaSendOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid OTP send request' });
    return;
  }

  const raw = await redis.get(`${MFA_CHALLENGE_PREFIX}${parsed.data.challengeId}`);
  if (!raw) {
    res.status(401).json({ error: 'Challenge expired — sign in again' });
    return;
  }
  const challenge = JSON.parse(raw) as MfaChallenge;

  try {
    const result = parsed.data.channel === 'email_otp'
      ? await sendEmailOtp(challenge.empId, 'login')
      : await sendSmsOtp(challenge.empId, 'login');
    res.json({ sent: true, devCode: result.devCode, maskedPhone: 'maskedPhone' in result ? result.maskedPhone : undefined });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not send code' });
  }
}

const mfaWebAuthnOptionsSchema = z.object({
  challengeId: z.string().uuid(),
});

export async function localLoginMfaWebAuthnOptionsHandler(req: Request, res: Response): Promise<void> {
  const parsed = mfaWebAuthnOptionsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid WebAuthn options request' });
    return;
  }

  const raw = await redis.get(`${MFA_CHALLENGE_PREFIX}${parsed.data.challengeId}`);
  if (!raw) {
    res.status(401).json({ error: 'Challenge expired — sign in again' });
    return;
  }
  const challenge = JSON.parse(raw) as MfaChallenge;
  const origin = resolveWebAuthnOrigin(req);

  try {
    const { options, challengeId: webauthnChallengeId } = await getWebAuthnAuthenticationOptions(
      challenge.empId,
      origin,
    );
    res.json({ options, webauthnChallengeId });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'WebAuthn unavailable' });
  }
}

const mfaWebAuthnVerifySchema = z.object({
  challengeId:         z.string().uuid(),
  webauthnChallengeId: z.string().uuid(),
  response:            z.record(z.unknown()),
});

export async function localLoginMfaWebAuthnVerifyHandler(req: Request, res: Response): Promise<void> {
  const parsed = mfaWebAuthnVerifySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid WebAuthn verification request' });
    return;
  }

  const key = `${MFA_CHALLENGE_PREFIX}${parsed.data.challengeId}`;
  const raw = await redis.get(key);
  if (!raw) {
    res.status(401).json({ error: 'Challenge expired — sign in again' });
    return;
  }

  const challenge = JSON.parse(raw) as MfaChallenge;
  const origin = resolveWebAuthnOrigin(req);

  try {
    const ok = await verifyWebAuthnAuthentication(
      challenge.empId,
      parsed.data.webauthnChallengeId,
      parsed.data.response as unknown as Parameters<typeof verifyWebAuthnAuthentication>[2],
      origin,
    );
    if (!ok) {
      await logAttempt(challenge.email, getClientIp(req), false, 'mfa-webauthn-bad');
      res.status(401).json({ error: 'Passkey verification failed' });
      return;
    }
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Passkey verification failed' });
    return;
  }

  await redis.del(key);
  await logAttempt(challenge.email, getClientIp(req), true, 'mfa-webauthn-ok');
  await finishMfaChallenge(req, res, challenge);
}
