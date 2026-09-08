/**
 * Periodic reconcile of local DYNAMIC groups — adds/removes members when
 * department or email-domain rules match newly synced directory users.
 */
import { withSchedLock } from '../utils/sched-lock.js';
import { reconcileAllDynamicGroups } from './dynamic-groups.js';
import logger from '../utils/logger.js';

let timer: ReturnType<typeof setInterval> | null = null;

const DEFAULT_TICK_MS = 5 * 60 * 1000;
const LOCK_TTL_MS = 270_000;

function tickMs(): number {
  const raw = parseInt(process.env['DYNAMIC_GROUP_RECONCILE_INTERVAL_MS'] ?? '', 10);
  if (!Number.isFinite(raw) || raw < 60_000) return DEFAULT_TICK_MS;
  return raw;
}

function enabled(): boolean {
  const v = (process.env['DYNAMIC_GROUP_RECONCILE_ENABLED'] ?? 'true').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'no';
}

export function startDynamicGroupScheduler(): void {
  if (timer || !enabled()) {
    if (!enabled()) {
      logger.info('Dynamic group reconcile scheduler disabled (DYNAMIC_GROUP_RECONCILE_ENABLED=false)');
    }
    return;
  }

  const interval = tickMs();
  setTimeout(() => {
    void withSchedLock('dynamic-group-reconcile', LOCK_TTL_MS, sweep);
  }, 45_000).unref?.();

  timer = setInterval(() => {
    void withSchedLock('dynamic-group-reconcile', LOCK_TTL_MS, sweep);
  }, interval);
  timer.unref?.();

  logger.info({ tickMs: interval }, 'Dynamic group reconcile scheduler started');
}

export function stopDynamicGroupScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function sweep(): Promise<void> {
  try {
    const result = await reconcileAllDynamicGroups(null);
    if (result.added || result.removed) {
      logger.info(
        { groups: result.groups, added: result.added, removed: result.removed },
        'Dynamic group reconcile sweep complete',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Dynamic group reconcile sweep failed');
  }
}
