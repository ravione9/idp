import { redis } from './session-store.js';

const MFA_GRACE_PREFIX = 'lilg:mfa-grace:';

function mfaGraceKey(empId: string): string {
  return `${MFA_GRACE_PREFIX}${empId}`;
}

export async function ensureMfaGraceStarted(empId: string, gracePeriodHours: number): Promise<void> {
  if (gracePeriodHours <= 0) return;
  const ttlS = Math.max(gracePeriodHours * 3600, 3600);
  await redis.set(mfaGraceKey(empId), String(Date.now()), 'EX', ttlS, 'NX');
}

export async function getGraceRemainingMs(empId: string, gracePeriodHours: number): Promise<number> {
  if (gracePeriodHours <= 0) return 0;
  const raw = await redis.get(mfaGraceKey(empId));
  if (!raw) return 0;
  const startedAt = Number(raw);
  if (Number.isNaN(startedAt)) return 0;
  const remaining = startedAt + gracePeriodHours * 3600 * 1000 - Date.now();
  return remaining > 0 ? remaining : 0;
}

export async function clearMfaGrace(empId: string): Promise<void> {
  await redis.del(mfaGraceKey(empId));
}
