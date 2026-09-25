/**
 * MFA enrollment grace window.
 *
 * Start time is persisted on `employees.mfa_grace_started_at` so the window cannot
 * reset when a short-lived Redis key expires (previous bug: NX+TTL = endless grace).
 * Legacy Redis keys and prior defer/enroll-pending auth attempts are healed into the DB.
 */
import { execute, queryOne } from '../db/connection.js';
import { redis } from './session-store.js';

const MFA_GRACE_PREFIX = 'lilg:mfa-grace:';

function mfaGraceKey(empId: string): string {
  return `${MFA_GRACE_PREFIX}${empId}`;
}

function toEpochMs(value: Date | string | number): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

async function readDbGraceStartedMs(empId: string): Promise<number | null> {
  const row = await queryOne<{ mfa_grace_started_at: Date | string | null }>(
    'SELECT mfa_grace_started_at FROM employees WHERE emp_id = ? LIMIT 1',
    [empId],
  ).catch(() => null);
  if (!row?.mfa_grace_started_at) return null;
  return toEpochMs(row.mfa_grace_started_at);
}

async function setDbGraceStartedAtMs(empId: string, startedAtMs: number): Promise<void> {
  await execute(
    `UPDATE employees
        SET mfa_grace_started_at = FROM_UNIXTIME(? / 1000)
      WHERE emp_id = ?
        AND mfa_grace_started_at IS NULL`,
    [startedAtMs, empId],
  );
}

/** Heal legacy Redis grace marker into DB (one-shot), then drop the Redis key. */
async function healLegacyRedisGrace(empId: string): Promise<number | null> {
  const raw = await redis.get(mfaGraceKey(empId)).catch(() => null);
  if (!raw) return null;
  const startedAt = Number(raw);
  if (!Number.isFinite(startedAt) || startedAt <= 0) {
    await redis.del(mfaGraceKey(empId)).catch(() => undefined);
    return null;
  }
  await setDbGraceStartedAtMs(empId, startedAt).catch(() => undefined);
  await redis.del(mfaGraceKey(empId)).catch(() => undefined);
  return startedAt;
}

/**
 * If the user already deferred / hit enroll-pending before DB tracking existed,
 * anchor grace to that first event so skip cannot restart a fresh window.
 */
async function healFromAuthHistory(empId: string): Promise<number | null> {
  const emp = await queryOne<{ email_corp: string | null; email_personal: string | null }>(
    'SELECT email_corp, email_personal FROM employees WHERE emp_id = ? LIMIT 1',
    [empId],
  ).catch(() => null);
  const emails = [emp?.email_corp, emp?.email_personal].filter(
    (e): e is string => Boolean(e && e.trim()),
  );
  if (emails.length === 0) return null;

  const placeholders = emails.map(() => '?').join(', ');
  const row = await queryOne<{ ts: Date | string }>(
    `SELECT MIN(ts) AS ts
       FROM auth_attempts
      WHERE email IN (${placeholders})
        AND success = 1
        AND reason IN (
          'mfa-enroll-deferred-grace',
          'mfa-enroll-deferred',
          'password-ok-mfa-enroll-pending'
        )`,
    emails,
  ).catch(() => null);
  if (!row?.ts) return null;
  const startedAt = toEpochMs(row.ts);
  if (startedAt == null) return null;
  await setDbGraceStartedAtMs(empId, startedAt).catch(() => undefined);
  return startedAt;
}

export async function ensureMfaGraceStarted(empId: string, gracePeriodHours: number): Promise<void> {
  if (gracePeriodHours <= 0) return;

  const existing = await readDbGraceStartedMs(empId);
  if (existing != null) {
    await redis.del(mfaGraceKey(empId)).catch(() => undefined);
    return;
  }

  const healedRedis = await healLegacyRedisGrace(empId);
  if (healedRedis != null) return;

  const healedHistory = await healFromAuthHistory(empId);
  if (healedHistory != null) return;

  await execute(
    `UPDATE employees
        SET mfa_grace_started_at = UTC_TIMESTAMP()
      WHERE emp_id = ?
        AND mfa_grace_started_at IS NULL`,
    [empId],
  );
}

export async function getGraceRemainingMs(empId: string, gracePeriodHours: number): Promise<number> {
  if (gracePeriodHours <= 0) return 0;

  let startedAt = await readDbGraceStartedMs(empId);
  if (startedAt == null) {
    startedAt = await healLegacyRedisGrace(empId);
  }
  if (startedAt == null) {
    startedAt = await healFromAuthHistory(empId);
  }
  if (startedAt == null) return 0;

  const remaining = startedAt + gracePeriodHours * 3600 * 1000 - Date.now();
  return remaining > 0 ? remaining : 0;
}

export async function clearMfaGrace(empId: string): Promise<void> {
  await execute(
    'UPDATE employees SET mfa_grace_started_at = NULL WHERE emp_id = ?',
    [empId],
  ).catch(() => undefined);
  await redis.del(mfaGraceKey(empId)).catch(() => undefined);
}
