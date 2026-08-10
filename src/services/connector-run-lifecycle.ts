/**
 * Connector run lifecycle — reclaim sync jobs left RUNNING after API restarts (K8s rollouts).
 */
import { execute, queryOne } from '../db/connection.js';
import logger from '../utils/logger.js';

/** Any unfinished run older than this is marked FAILED (scheduler + boot). */
export const CONNECTOR_RUN_STALE_HOURS = 3;

/** Runs that never incremented items_processed are reclaimed sooner (auth/config crash). */
export const CONNECTOR_RUN_ZERO_PROGRESS_MINUTES = 15;

const ACTIVE_STATUSES_SQL = "('RUNNING', 'PENDING_AGENT')";

export async function reclaimStaleConnectorRuns(connectorId?: string): Promise<number> {
  let reclaimed = 0;

  reclaimed += await reclaimRunsWhere(
    `status IN ${ACTIVE_STATUSES_SQL}
       AND ended_at IS NULL
       AND items_processed = 0
       AND started_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE)`,
    [CONNECTOR_RUN_ZERO_PROGRESS_MINUTES],
    connectorId,
    'zero-progress timeout',
  );

  reclaimed += await reclaimRunsWhere(
    `status IN ${ACTIVE_STATUSES_SQL}
       AND ended_at IS NULL
       AND started_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR)`,
    [CONNECTOR_RUN_STALE_HOURS],
    connectorId,
    'stale timeout',
  );

  if (reclaimed > 0) {
    logger.warn(
      { reclaimed, connectorId: connectorId ?? 'all' },
      'Reclaimed stale connector sync runs',
    );
  }
  return reclaimed;
}

/** Admin manual sync — drop any unfinished run so a fresh sync can start immediately. */
export async function forceReclaimConnectorRuns(connectorId: string): Promise<number> {
  const reclaimed = await reclaimRunsWhere(
    `status IN ${ACTIVE_STATUSES_SQL} AND ended_at IS NULL`,
    [],
    connectorId,
    'superseded by manual sync',
  );
  if (reclaimed > 0) {
    logger.warn({ reclaimed, connectorId }, 'Force-reclaimed active connector sync runs');
  }
  return reclaimed;
}

async function reclaimRunsWhere(
  whereCore: string,
  params: unknown[],
  connectorId: string | undefined,
  reason: string,
): Promise<number> {
  const paramsCopy = [...params];
  let sql = `
    UPDATE connector_runs
       SET status = 'FAILED',
           ended_at = UTC_TIMESTAMP(),
           error_summary = ?
     WHERE ${whereCore}`;

  paramsCopy.unshift(`Reclaimed: ${reason}`);

  if (connectorId) {
    sql += ' AND connector_id = ?';
    paramsCopy.push(connectorId);
  }

  const result = await execute(sql, paramsCopy);
  return Number(result.affectedRows ?? 0);
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

export async function assertConnectorSyncCanStart(
  connectorId: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (opts.force) {
    await forceReclaimConnectorRuns(connectorId);
    return;
  }

  await reclaimStaleConnectorRuns(connectorId);
  const active = await findActiveConnectorRun(connectorId);
  if (active) {
    throw new Error(
      `A sync is already in progress for this connector (${active.status}, run ${active.id}). `
      + 'Wait for it to finish or click Sync again after a few minutes.',
    );
  }
}

export async function failConnectorRunIfActive(
  runId: string,
  err: unknown,
  counts: { itemsProcessed?: number; itemsSucceeded?: number; itemsFailed?: number } = {},
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await execute(
    `UPDATE connector_runs
        SET status = 'FAILED',
            ended_at = UTC_TIMESTAMP(),
            items_processed = ?,
            items_succeeded = ?,
            items_failed = ?,
            error_summary = ?
      WHERE id = ?
        AND status IN ('RUNNING', 'PENDING_AGENT')
        AND ended_at IS NULL`,
    [
      counts.itemsProcessed ?? 0,
      counts.itemsSucceeded ?? 0,
      counts.itemsFailed ?? 0,
      message.slice(0, 4000),
      runId,
    ],
  );
}

/** Live progress for long directory syncs — UI reads items_* + payload.phase while status is RUNNING. */
export async function updateConnectorRunProgress(
  runId: string,
  progress: {
    phase: string;
    itemsProcessed: number;
    itemsSucceeded: number;
    itemsFailed: number;
    detail?: string;
  },
): Promise<void> {
  const payload = {
    phase: progress.phase,
    detail: progress.detail ?? null,
    progressAt: new Date().toISOString(),
  };
  await execute(
    `UPDATE connector_runs
        SET items_processed = ?,
            items_succeeded = ?,
            items_failed = ?,
            payload = ?
      WHERE id = ?
        AND status IN ('RUNNING', 'PENDING_AGENT')
        AND ended_at IS NULL`,
    [
      progress.itemsProcessed,
      progress.itemsSucceeded,
      progress.itemsFailed,
      JSON.stringify(payload),
      runId,
    ],
  );
}
