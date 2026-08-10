import { query } from '../db/connection.js';
import logger from '../utils/logger.js';
import { withSchedLock } from '../utils/sched-lock.js';
import { connectorSyncIsDue, parseSyncSchedule } from '../utils/sync-schedule.js';
import { isConnectorSyncEligible } from './connector-health.js';
import { triggerConnectorSync } from './connector-dispatcher.js';
import { findActiveConnectorRun, reclaimStaleConnectorRuns } from './connector-run-lifecycle.js';

const TICK_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
const runningByConnector = new Set<string>();

interface ConnectorScheduleRow {
  id: string;
  name: string;
  status: string;
  sync_schedule: string | null;
  last_sync_at: string | null;
}

export function startConnectorSyncScheduler(): void {
  if (timer) return;

  const lockTtlMs = TICK_MS - 5_000;
  const lockedTick = () => withSchedLock('connector-sync', lockTtlMs, tickAll);

  setTimeout(() => { void lockedTick(); }, 90_000).unref();
  timer = setInterval(() => { void lockedTick(); }, TICK_MS);
  timer.unref();
  logger.info({ tickMs: TICK_MS }, 'Connector sync scheduler started');
}

async function tickAll(): Promise<void> {
  try {
    await reclaimStaleConnectorRuns();

    const rows = await query<ConnectorScheduleRow>(
      `SELECT id, name, status, sync_schedule, last_sync_at
         FROM connectors
        WHERE sync_schedule IS NOT NULL
          AND TRIM(sync_schedule) != ''
          AND LOWER(TRIM(sync_schedule)) != 'manual'
          AND status IN ('CONNECTED', 'ACTIVE')
        ORDER BY last_sync_at IS NULL DESC, last_sync_at ASC
        LIMIT 50`,
      [],
    );

    const now = new Date();
    for (const row of rows) {
      const parsed = parseSyncSchedule(row.sync_schedule);
      if (parsed.kind === 'manual') continue;
      if (!isConnectorSyncEligible(row.status)) continue;
      if (!connectorSyncIsDue(row.sync_schedule, row.last_sync_at, now)) continue;
      if (runningByConnector.has(row.id)) continue;

      const activeRun = await findActiveConnectorRun(row.id);
      if (activeRun) continue;

      runningByConnector.add(row.id);
      try {
        logger.info(
          { connectorId: row.id, name: row.name, schedule: row.sync_schedule },
          'Connector scheduled sync starting',
        );
        await triggerConnectorSync(row.id, 'connector-scheduler');
      } catch (err) {
        logger.warn({ err, connectorId: row.id }, 'Connector scheduled sync failed to start');
      } finally {
        runningByConnector.delete(row.id);
      }
    }
  } catch (err) {
    logger.error({ err }, 'Connector sync scheduler tick failed');
  }
}

export function stopConnectorSyncScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
