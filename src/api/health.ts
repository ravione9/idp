import { Router, Request, Response } from 'express';
import { pool, query } from '../db/connection.js';
import { redis } from '../auth/session-store.js';
import logger from '../utils/logger.js';

const router = Router();

// ---------------------------------------------------------------------------
// GET /healthz — liveness (always 200 if process is up)
// ---------------------------------------------------------------------------
router.get('/healthz', (_req: Request, res: Response): void => {
  res.status(200).json({ status: 'ok', ts: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// GET /readyz — readiness (checks DB + Redis)
// ---------------------------------------------------------------------------
router.get('/readyz', async (_req: Request, res: Response): Promise<void> => {
  const checks: Record<string, string> = {};
  let allOk = true;

  // DB check
  try {
    await query('SELECT 1', []);
    checks['db'] = 'ok';
  } catch (err) {
    checks['db'] = `error: ${err instanceof Error ? err.message : String(err)}`;
    allOk = false;
    logger.error({ err }, 'Readyz: DB check failed');
  }

  // Redis check
  try {
    const pong = await redis.ping();
    checks['redis'] = pong === 'PONG' ? 'ok' : `unexpected: ${pong}`;
    if (pong !== 'PONG') allOk = false;
  } catch (err) {
    checks['redis'] = `error: ${err instanceof Error ? err.message : String(err)}`;
    allOk = false;
    logger.error({ err }, 'Readyz: Redis check failed');
  }

  res.status(allOk ? 200 : 503).json({ status: allOk ? 'ready' : 'not_ready', checks });
});

// ---------------------------------------------------------------------------
// GET /diagz — diagnostic helper: which migrations applied, which IGA tables
// exist. Useful when debugging "why is /api/iga/applications crashing?".
// ---------------------------------------------------------------------------
router.get('/diagz', async (_req: Request, res: Response): Promise<void> => {
  const out: Record<string, unknown> = {};
  try {
    const m = await query<{ name: string; applied_at: string }>(
      'SELECT name, applied_at FROM lilg_schema_migrations ORDER BY name',
      [],
    );
    out['migrations'] = m;
  } catch (err) {
    out['migrations_error'] = err instanceof Error ? err.message : String(err);
  }
  try {
    const tables = await query<{ name: string; exists: number }>(
      `SELECT 'applications' AS name, COUNT(*) AS exists FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'applications'
       UNION ALL SELECT 'app_protocol_configs', COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'app_protocol_configs'
       UNION ALL SELECT 'connectors',           COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'connectors'
       UNION ALL SELECT 'entitlements',         COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'entitlements'
       UNION ALL SELECT 'user_entitlements',    COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'user_entitlements'
       UNION ALL SELECT 'access_requests',      COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'access_requests'
       UNION ALL SELECT 'sod_policies',         COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'sod_policies'
       UNION ALL SELECT 'risk_scores',          COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'risk_scores'
       UNION ALL SELECT 'compliance_reports',   COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'compliance_reports'`,
      [],
    );
    out['iga_tables'] = tables;
  } catch (err) {
    out['iga_tables_error'] = err instanceof Error ? err.message : String(err);
  }
  res.json(out);
});

// ---------------------------------------------------------------------------
// GET /metrics — Prometheus exposition format
// ---------------------------------------------------------------------------
router.get('/metrics', async (_req: Request, res: Response): Promise<void> => {
  const lines: string[] = [];

  // Outbox queue depth by status
  try {
    const rows = await query<{ status: string; count: number }>(
      `SELECT status, COUNT(*) AS count FROM adapter_outbox GROUP BY status`,
      [],
    );
    lines.push('# HELP lilg_outbox_queue_depth Number of outbox rows by status');
    lines.push('# TYPE lilg_outbox_queue_depth gauge');
    for (const row of rows) {
      lines.push(`lilg_outbox_queue_depth{status="${row.status}"} ${row.count}`);
    }
  } catch (err) {
    logger.warn({ err }, 'Metrics: outbox query failed');
  }

  // Active sessions count from Redis
  try {
    const keys = await redis.keys('lilg:session:*');
    lines.push('# HELP lilg_active_sessions Number of active sessions in Redis');
    lines.push('# TYPE lilg_active_sessions gauge');
    lines.push(`lilg_active_sessions ${keys.length}`);
  } catch (err) {
    logger.warn({ err }, 'Metrics: Redis session count failed');
  }

  // DB connection pool stats
  try {
    // mysql2 PoolCluster exposes pool stats via _allConnections etc. (internal API)
    // We use pool as the mysql2 Pool type and access _allConnections
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const poolAny = pool as any;
    const total    = poolAny._allConnections?.length ?? 0;
    const free     = poolAny._freeConnections?.length ?? 0;
    const queued   = poolAny._connectionQueue?.length ?? 0;

    lines.push('# HELP lilg_db_pool_total Total connections in pool');
    lines.push('# TYPE lilg_db_pool_total gauge');
    lines.push(`lilg_db_pool_total ${total}`);

    lines.push('# HELP lilg_db_pool_free Free (available) connections in pool');
    lines.push('# TYPE lilg_db_pool_free gauge');
    lines.push(`lilg_db_pool_free ${free}`);

    lines.push('# HELP lilg_db_pool_queued Queued requests waiting for a connection');
    lines.push('# TYPE lilg_db_pool_queued gauge');
    lines.push(`lilg_db_pool_queued ${queued}`);
  } catch (err) {
    logger.warn({ err }, 'Metrics: DB pool stats unavailable');
  }

  // ILG state distribution
  try {
    const states = await query<{ ilg_state: string; count: number }>(
      `SELECT ilg_state, COUNT(*) AS count FROM employees GROUP BY ilg_state`,
      [],
    );
    lines.push('# HELP lilg_employee_state_count Number of employees per ILG state');
    lines.push('# TYPE lilg_employee_state_count gauge');
    for (const s of states) {
      lines.push(`lilg_employee_state_count{state="${s.ilg_state}"} ${s.count}`);
    }
  } catch (err) {
    logger.warn({ err }, 'Metrics: employee state query failed');
  }

  res.set('Content-Type', 'text/plain; version=0.0.4').send(lines.join('\n') + '\n');
});

export default router;
