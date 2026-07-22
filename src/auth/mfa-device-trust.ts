/**
 * Remember-MFA device trust cookie.
 * After a successful MFA challenge, skip MFA on subsequent password/OIDC logins
 * from the same browser User-Agent for remember_device_hours (mfa_policy).
 * Adaptive MFA / STEP_UP still forces a challenge.
 */
import crypto from 'crypto';
import { Request, Response } from 'express';
import { config } from '../config.js';
import { timingSafeEqualString } from '../utils/timing-safe.js';

export const MFA_TRUST_COOKIE = 'idp_mfa_trust';

function uaFingerprint(userAgent: string): string {
  return crypto.createHash('sha256').update(userAgent || '').digest('base64url').slice(0, 22);
}

function sign(payload: string): string {
  const hmac = crypto
    .createHmac('sha256', config.session.secret)
    .update(payload)
    .digest('base64url');
  return `${payload}.${hmac}`;
}

function verifySigned(raw: string): string | null {
  const lastDot = raw.lastIndexOf('.');
  if (lastDot < 0) return null;
  const payload = raw.slice(0, lastDot);
  const sig = raw.slice(lastDot + 1);
  const expected = crypto
    .createHmac('sha256', config.session.secret)
    .update(payload)
    .digest('base64url');
  return timingSafeEqualString(sig, expected) ? payload : null;
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers['cookie'] ?? '';
  const match = header.match(new RegExp(`${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]!) : null;
}

export function setMfaDeviceTrustCookie(
  res: Response,
  empId: string,
  hours: number,
  userAgent: string,
): void {
  if (hours <= 0) {
    clearMfaDeviceTrustCookie(res);
    return;
  }
  const exp = Date.now() + hours * 3600 * 1000;
  const payload = `${empId}|${exp}|${uaFingerprint(userAgent)}`;
  res.cookie(MFA_TRUST_COOKIE, sign(payload), {
    httpOnly: true,
    secure:   config.session.cookieSecure,
    sameSite: 'lax',
    maxAge:   hours * 3600 * 1000,
    path:     '/',
  });
}

export function clearMfaDeviceTrustCookie(res: Response): void {
  res.clearCookie(MFA_TRUST_COOKIE, { path: '/' });
}

export function hasValidMfaDeviceTrust(req: Request, empId: string): boolean {
  const raw = readCookie(req, MFA_TRUST_COOKIE);
  if (!raw) return false;
  const payload = verifySigned(raw);
  if (!payload) return false;

  const parts = payload.split('|');
  if (parts.length !== 3) return false;
  const [cookieEmpId, expRaw, fp] = parts;
  if (cookieEmpId !== empId) return false;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;

  const ua = req.get('user-agent') ?? '';
  return fp === uaFingerprint(ua);
}
