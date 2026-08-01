/**
 * MFA challenge for an already-authenticated portal session (critical-app step-up).
 */
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { resolveSession } from './middleware.js';
import {
  MFA_CHALLENGE_PREFIX,
  MFA_CHALLENGE_TTL_S,
  safeChallengeReturnTo,
  type MfaChallenge,
} from './local-auth.js';
import { challengeMethodsFromStatus, getMfaStatus } from './mfa.js';
import { redis } from './session-store.js';

/** POST /auth/session/mfa-challenge  { returnTo? } */
export async function sessionMfaChallengeHandler(req: Request, res: Response): Promise<void> {
  const user = await resolveSession(req, res);
  if (!user) {
    res.status(401).json({ error: 'Sign in required' });
    return;
  }

  const returnTo = safeChallengeReturnTo(
    typeof req.body?.returnTo === 'string' ? req.body.returnTo : undefined,
  );
  const mfaState = await getMfaStatus(user.empId);
  if (!mfaState.enabled) {
    res.status(403).json({
      error: 'MFA enrollment is required before accessing this critical application. Enroll under Settings → MFA, then retry.',
      enrollRequired: true,
    });
    return;
  }

  const challengeId = crypto.randomUUID();
  const challenge: MfaChallenge = {
    empId:         user.empId,
    email:         user.email,
    role:          user.role,
    accountId:     0,
    createdAt:     Date.now(),
    stepUp:        true,
    sessionStepUp: true,
    sessionId:     user.sessionId,
    iss:           (user.iss === 'google' ? 'google' : 'local'),
    sub:           user.sub,
    ...(returnTo ? { returnTo } : {}),
  };
  await redis.set(
    `${MFA_CHALLENGE_PREFIX}${challengeId}`,
    JSON.stringify(challenge),
    'EX',
    MFA_CHALLENGE_TTL_S,
  );
  res.json({
    mfaRequired: true,
    challengeId,
    stepUp: true,
    appStepUp: true,
    email: user.email,
    availableMethods: challengeMethodsFromStatus(mfaState),
  });
}
