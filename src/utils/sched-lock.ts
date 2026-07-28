/**
 * Best-effort distributed mutex for scheduler ticks (Redis SET NX PX).
 * Lock auto-expires; we deliberately do NOT release early, so a tick
 * runs at most once per TTL window across all pods.
 */
import { redis } from '../auth/session-store.js';
import logger from './logger.js';

export async function withSchedLock(
  name: string,
  ttlMs: number,
  fn: () => Promise<void>,
): Promise<void> {
  const key = `idp:sched:${name}:lock`;
  try {
    const ok = await redis.set(
      key,
      `${process.env['HOSTNAME'] ?? 'pod'}:${Date.now()}`,
      'PX',
      ttlMs,
      'NX',
    );
    if (ok !== 'OK') return; // another pod owns this tick
  } catch (err) {
    logger.warn({ err, name }, 'Sched lock: Redis unavailable — running tick locally (may duplicate)');
  }
  await fn();
}
