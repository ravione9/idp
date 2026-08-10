/**
 * Connector run lifecycle — reclaim sync jobs left RUNNING after API restarts (K8s rollouts).
 */
import { execute, queryOne } from '../db/connection.js';
import logger from '../utils/logger.js';

/** Runs with no end time older than this are marked FAILED so new syncs can start. */
export const CONNECTOR_RUN_STALE_HOURS = 3;

export async function reclaimStaleConnectorRuns(connectorId?: string): Promise<number> {
  const params: unknown[] = [CONNECTOR_RUN_STALE_HOURS];
  let sql = `
    UPDATE connector_runs
       SET status = 'FAILED',
           ended_at = UTC_TIMESTAMP(),
           error_summary = 'Reclaimed: sync did not finish within ${CONNECTOR_RUN_STALE_HOURS}h (API restart, timeout, or agent never claimed the job)'
     WHERE status IN ('RUNNING', 'PENDING_AGENT')
       AND ended_at IS NULL
       AND started_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR)`;

  if (connectorId) {
    sql += ' AND connector_id = ?';
    params.push(connectorId);
  }

  const result = await execute(sql, params);
  const reclaimed = Number(result.affectedRows ?? 0);
  if (reclaimed > 0) {
    logger.warn(
      { reclaimed, connectorId: connectorId ?? 'all', staleHours: CONNECTOR_RUN_STALE_HOURS },
      'Reclaimed stale connector sync runs',
    );
  }
  return reclaimed;
}

export async function findActiveConnectorRun(connectorId: string): Promise<{ id: string; status: string } | null> {
  return queryOne<{ id: string; status: string }>(
    `SELECT id, status
       FROM connector_runs
      WHERE connector_id = ?
        AND status IN ('RUNNING', 'PENDING_AGENT')
      ORDER BY started_at DESC
      LIMIT 1`,
    [connectorId],
  );
}

export async function assertConnectorSyncCanStart(connectorId: string): Promise<void> {
  await reclaimStaleConnectorRuns(connectorId);
  const active = await findActiveConnectorRun(connectorId);
  if (active) {
    throw new Error(
      `A sync is already in progress for this connector (${active.status}, run ${active.id}). `
      + 'Wait for it to finish or retry after the stale timeout.',
    );
  }
}
