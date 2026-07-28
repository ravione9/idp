/**
 * Periodically expire stale PENDING access requests and wipe their approval queue.
 */
import logger from '../utils/logger.js';
import { withSchedLock } from '../utils/sched-lock.js';
import { expireStaleAccessRequests } from './app-access-policy.js';

let timer: ReturnType<typeof setInterval> | null = null;

const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const LOCK_TTL_MS = 270_000; // 4.5 min — just under the interval

export function startAccessRequestExpiryScheduler(): void {
  if (timer) return;
  // Run once shortly after boot, then on interval
  setTimeout(() => {
    void withSchedLock('access-request-expiry', LOCK_TTL_MS, sweep);
  }, 15_000).unref?.();
  timer = setInterval(() => {
    void withSchedLock('access-request-expiry', LOCK_TTL_MS, sweep);
  }, INTERVAL_MS);
  timer.unref?.();
  logger.info({ intervalMs: INTERVAL_MS }, 'Access-request expiry scheduler started');
}

export function stopAccessRequestExpiryScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function sweep(): Promise<void> {
  try {
    const n = await expireStaleAccessRequests();
    if (n > 0) {
      logger.info({ expired: n }, 'Access-request expiry sweep wiped stale approvals');
    }
  } catch (err) {
    logger.warn({ err }, 'Access-request expiry sweep failed');
  }
}
