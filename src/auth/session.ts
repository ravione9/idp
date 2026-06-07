/**
 * LILG session creation and cookie helpers (shared by OIDC + local login)
 */

import crypto from 'crypto';
import { Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { query } from '../db/connection.js';
import { redis } from './session-store.js';
import type { LilgUser } from './types.js';

export const COOKIE_NAME = 'idp_sid';
const SESSION_REDIS_PREFIX = 'idp:session:';

export function signSessionId(sessionId: string): string {
  const hmac = crypto.createHmac('sha256', config.session.secret);
  hmac.update(sessionId);
  return `${sessionId}.${hmac.digest('base64url')}`;
}

export function verifySessionCookie(raw: string): string | null {
  const lastDot = raw.lastIndexOf('.');
  if (lastDot < 0) return null;

  const id  = raw.slice(0, lastDot);
  const sig = raw.slice(lastDot + 1);

  const expected = crypto
    .createHmac('sha256', config.session.secret)
    .update(id)
    .digest('base64url');

  const ok = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  return ok ? id : null;
}

async function cacheSession(user: LilgUser): Promise<void> {
  const key     = `${SESSION_REDIS_PREFIX}${user.sessionId}`;
  const payload = JSON.stringify(user);
  const ttl     = Math.floor((user.expiresAt.getTime() - Date.now()) / 1000);
  if (ttl > 0) {
    await redis.set(key, payload, 'EX', ttl);
  }
}

export async function createSession(params: {
  empId:           string;
  email:           string;
  role:            string;
  iss:             string;
  sub:             string;
  ttlHours:        number;
  ip:              string;
  userAgent:       string;
  clientHostname?:  string | null;
  clientLocalIp?:   string | null;
  clientMac?:       string | null;
}): Promise<string> {
  const sessionId  = uuidv4();
  const expiresAt  = new Date(Date.now() + params.ttlHours * 3600 * 1000);

  await query(
    `INSERT INTO idp_sessions
       (session_id, emp_id, iss, sub, email, role, created_at, last_active_at, expires_at,
        ip, user_agent, client_hostname, client_local_ip, client_mac)
     VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP(), ?, ?, ?, ?, ?, ?)`,
    [sessionId, params.empId, params.iss, params.sub, params.email, params.role,
     expiresAt.toISOString().slice(0, 19).replace('T', ' '),
     params.ip, params.userAgent,
     params.clientHostname ?? null, params.clientLocalIp ?? null, params.clientMac ?? null],
  );

  const user: LilgUser = {
    sessionId,
    empId:     params.empId,
    email:     params.email,
    role:      params.role,
    iss:       params.iss,
    sub:       params.sub,
    expiresAt,
  };
  await cacheSession(user);
  return sessionId;
}

export function setSessionCookie(res: Response, sessionId: string, ttlHours: number): void {
  res.cookie(COOKIE_NAME, signSessionId(sessionId), {
    httpOnly: true,
    secure:   config.session.cookieSecure,
    sameSite: 'lax',
    maxAge:   ttlHours * 3600 * 1000,
    path:     '/',
  });
}

export async function cacheSessionUser(user: LilgUser): Promise<void> {
  await cacheSession(user);
}

export { SESSION_REDIS_PREFIX };
