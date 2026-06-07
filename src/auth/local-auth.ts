/**
 * Local email + password login for administrators.
 * Two-step flow when MFA is enabled:
 *   1. POST /auth/local/login            { email, password }       → { mfaRequired:true, challengeId }
 *   2. POST /auth/local/login/mfa-verify { challengeId, code }     → { success:true, redirect:'/' }
 */
import { Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { config } from '../config.js';
import logger from '../utils/logger.js';
import { createSession, setSessionCookie } from './session.js';
import { redis } from './session-store.js';
import { getMfaStatus, verifyTotp } from './mfa.js';
import { query } from '../db/connection.js';
import {
  ensureMasterAdminFromEnv,
  findLocalAccountByEmail,
  isMasterAdminCredentials,
  touchLocalLogin,
  verifyLocalPassword,
} from '../services/local-admin.js';
import { authenticateAdCorporateUser } from '../services/ad-auth.js';
import { getClientIp } from '../utils/request-context.js';

const MFA_CHALLENGE_PREFIX = 'lilg:mfa-challenge:';
const MFA_CHALLENGE_TTL_S  = 300; // 5 min

const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(8),
});

const verifySchema = z.object({
  challengeId: z.string().uuid(),
  code:        z.string().min(6).max(8),
});

interface MfaChallenge {
  empId:     string;
  email:     string;
  role:      string;
  accountId: number;
  createdAt: number;
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
): Promise<void> {
  const sessionId = await createSession({
    empId:     account.emp_id,
    email:     account.email,
    role:      account.role,
    iss:       'local',
    sub:       `local:${account.id}`,
    ttlHours:  config.session.ttlCorporateHours,
    ip:        getClientIp(req),
    userAgent: req.get('user-agent') ?? '',
  });

  await touchLocalLogin(account.id);
  setSessionCookie(res, sessionId, config.session.ttlCorporateHours);
  logger.info({ empId: account.emp_id, email: account.email }, 'Local admin login');
  res.json({ success: true, redirect: '/' });
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
      account = await authenticateAdCorporateUser(email, password);
    }

    if (!account) {
      await logAttempt(email, ip, false, 'no-such-account');
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const valid = await verifyLocalPassword(password, account.password_hash);
    if (!valid) {
      await logAttempt(email, ip, false, 'bad-password');
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const mfa = await getMfaStatus(account.emp_id);
    if (mfa.enabled) {
      const challengeId = crypto.randomUUID();
      const challenge: MfaChallenge = {
        empId:     account.emp_id,
        email:     account.email,
        role:      account.role,
        accountId: account.id,
        createdAt: Date.now(),
      };
      await redis.set(
        `${MFA_CHALLENGE_PREFIX}${challengeId}`,
        JSON.stringify(challenge),
        'EX',
        MFA_CHALLENGE_TTL_S,
      );
      await logAttempt(email, ip, true, 'password-ok-mfa-pending');
      res.json({ mfaRequired: true, challengeId });
      return;
    }

    await logAttempt(email, ip, true);
    await issueSessionAndRespond(res, req, account);
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
  const ok = await verifyTotp(challenge.empId, parsed.data.code);
  if (!ok) {
    await logAttempt(challenge.email, getClientIp(req), false, 'mfa-bad-code');
    res.status(401).json({ error: 'Invalid verification code' });
    return;
  }

  await redis.del(key);
  await logAttempt(challenge.email, getClientIp(req), true, 'mfa-ok');

  await issueSessionAndRespond(res, req, {
    id:     challenge.accountId,
    emp_id: challenge.empId,
    email:  challenge.email,
    role:   challenge.role,
  });
}
