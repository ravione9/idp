import { Router, Request, Response, NextFunction } from 'express';
import { pool, query } from '../db/connection.js';
import { redis } from '../auth/session-store.js';
import logger from '../utils/logger.js';
import { config } from '../config.js';
import { timingSafeEqualString } from '../utils/timing-safe.js';

const router = Router();

/** /diagz and /metrics are sensitive — require internal token (Prometheus scrape header). */
function requireDiagToken(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers['x-internal-token'];
  const token = typeof header === 'string' ? header : '';
  if (!token || !timingSafeEqualString(token, config.app.internalToken)) {
    res.status(403).json({ error: 'Forbidden', code: 'DIAG_AUTH_REQUIRED' });
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// GET /healthz — liveness (always 200 if process is up)
// ---------------------------------------------------------------------------
router.get('/healthz', (_req: Request, res: Response): void => {
  res.status(200).json({
    status: 'ok',
    ts: new Date().toISOString(),
    build: process.env['GIT_COMMIT'] ?? process.env['IMAGE_TAG'] ?? 'dev',
  });
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
router.get('/diagz', requireDiagToken, async (_req: Request, res: Response): Promise<void> => {
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

  const probe = async (label: string, sql: string): Promise<Record<string, unknown>> => {
    try {
      const rows = await query(sql, []);
      return { table: label, ok: true, rows: (rows as unknown[]).length };
    } catch (err) {
      const e = err as { code?: string; errno?: number; sqlMessage?: string };
      return {
        table:   label,
        ok:      false,
        code:    e.code ?? null,
        errno:   e.errno ?? null,
        message: e.sqlMessage ?? (err instanceof Error ? err.message : String(err)),
      };
    }
  };

  out['probes'] = [
    await probe('applications',                'SELECT id FROM applications LIMIT 1'),
    await probe('app_protocol_configs',        'SELECT id FROM app_protocol_configs LIMIT 1'),
    await probe('connectors',                  'SELECT id FROM connectors LIMIT 1'),
    await probe('connector_runs',              'SELECT id FROM connector_runs LIMIT 1'),
    await probe('entitlements',                'SELECT id FROM entitlements LIMIT 1'),
    await probe('user_entitlements',           'SELECT id FROM user_entitlements LIMIT 1'),
    await probe('business_roles',              'SELECT id FROM business_roles LIMIT 1'),
    await probe('access_requests',             'SELECT id FROM access_requests LIMIT 1'),
    await probe('access_request_approvals',    'SELECT id FROM access_request_approvals LIMIT 1'),
    await probe('access_review_campaigns',     'SELECT id FROM access_review_campaigns LIMIT 1'),
    await probe('access_review_items',         'SELECT id FROM access_review_items LIMIT 1'),
    await probe('sod_policies',                'SELECT id FROM sod_policies LIMIT 1'),
    await probe('sod_violations',              'SELECT id FROM sod_violations LIMIT 1'),
    await probe('risk_scores',                 'SELECT emp_id FROM risk_scores LIMIT 1'),
    await probe('login_risk_events',           'SELECT id FROM login_risk_events LIMIT 1'),
    await probe('compliance_reports',          'SELECT id FROM compliance_reports LIMIT 1'),
    await probe('notifications',               'SELECT id FROM notifications LIMIT 1'),
    await probe('oidc_clients',                'SELECT id FROM oidc_clients LIMIT 1'),
    await probe('oauth_tokens',                'SELECT id FROM oauth_tokens LIMIT 1'),
    await probe('webauthn_credentials',        'SELECT id FROM webauthn_credentials LIMIT 1'),
    // Run the actual /api/iga/applications query so any column-name bug surfaces here
    await probe(
      'iga_apps_query',
      `SELECT a.id, a.slug, a.name,
              (SELECT COUNT(*) FROM app_protocol_configs c WHERE c.app_id = a.id AND c.active = 1) AS protocol_count
         FROM applications a
        ORDER BY a.sort_order ASC, a.name ASC
        LIMIT 1`,
    ),
  ];
  res.json(out);
});

// ---------------------------------------------------------------------------
// GET /metrics — Prometheus exposition format
// ---------------------------------------------------------------------------
router.get('/metrics', requireDiagToken, async (_req: Request, res: Response): Promise<void> => {
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
    const keys = await redis.keys('idp:session:*');
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
