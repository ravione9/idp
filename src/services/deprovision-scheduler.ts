/**
 * Auto-deprovision employees who have been suspended/disabled for longer than the grace period.
 * Directory sync disables users within one connector cycle (~15m); this job removes them after 24h.
 */
import { query } from '../db/connection.js';
import { withSchedLock } from '../utils/sched-lock.js';
import { deprovisionUser } from './user-lifecycle.js';
import logger from '../utils/logger.js';

let timer: ReturnType<typeof setInterval> | null = null;

const TICK_MS = 5 * 60 * 1000;
const LOCK_TTL_MS = 270_000;
const DEPROVISION_AFTER_HOURS = Math.max(
  1,
  parseInt(process.env['DEPROVISION_AFTER_HOURS'] ?? '24', 10) || 24,
);

export function startDeprovisionScheduler(): void {
  if (timer) return;
  setTimeout(() => {
    void withSchedLock('deprovision-sweep', LOCK_TTL_MS, sweep);
  }, 30_000).unref?.();
  timer = setInterval(() => {
    void withSchedLock('deprovision-sweep', LOCK_TTL_MS, sweep);
  }, TICK_MS);
  timer.unref?.();
  logger.info(
    { tickMs: TICK_MS, deprovisionAfterHours: DEPROVISION_AFTER_HOURS },
    'Deprovision scheduler started',
  );
}

export function stopDeprovisionScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function sweep(): Promise<void> {
  try {
    const rows = await query<{ emp_id: string; ilg_state: string }>(
      `SELECT emp_id, ilg_state
         FROM employees
        WHERE ilg_state IN ('SUSPENDED_AUTO', 'SUSPENDED_HR', 'DEPARTED')
          AND ilg_state_since <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR)
        ORDER BY ilg_state_since ASC
        LIMIT 200`,
      [DEPROVISION_AFTER_HOURS],
    );

    if (!rows.length) return;

    let deprovisioned = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        await deprovisionUser(
          row.emp_id,
          `AUTO_DEPROVISION_${DEPROVISION_AFTER_HOURS}H`,
          'deprovision-scheduler',
        );
        deprovisioned++;
      } catch (err) {
        failed++;
        logger.warn(
          { empId: row.emp_id, ilg_state: row.ilg_state, err },
          'Deprovision sweep: failed to deprovision employee',
        );
      }
    }

    logger.info(
      { candidates: rows.length, deprovisioned, failed, deprovisionAfterHours: DEPROVISION_AFTER_HOURS },
      'Deprovision sweep complete',
    );
  } catch (err) {
    logger.warn({ err }, 'Deprovision sweep failed');
  }
}
