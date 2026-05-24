/**
 * Config — System Health API
 * Mounted at /api/admin/system-health
 */
import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { requireRole } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import { query } from '../db/connection.js';
import { redis } from '../auth/session-store.js';
import logger from '../utils/logger.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('ADMIN', 'SUPER_ADMIN'));

router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const safeQuery = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    try { return await query<T>(sql, params); }
    catch (err) { logger.warn({ err }, `Health query failed: ${sql.slice(0, 60)}`); return []; }
  };

  const safeQueryOne = async <T>(sql: string, params: unknown[] = []): Promise<T | null> => {
    try {
      const rows = await query<T>(sql, params);
      return rows[0] ?? null;
    } catch { return null; }
  };

  let dbOk = false;
  let dbLatencyMs: number | null = null;
  try {
    const t0 = Date.now();
    await query('SELECT 1', []);
    dbOk = true;
    dbLatencyMs = Date.now() - t0;
  } catch { dbOk = false; }

  let redisOk = false;
  let redisLatencyMs: number | null = null;
  try {
    const t0 = Date.now();
    const p = await redis.ping();
    redisOk = p === 'PONG';
    redisLatencyMs = Date.now() - t0;
  } catch { redisOk = false; }

  const [queueDepth, connectorRows, migrations] = await Promise.all([
    safeQuery<{ status: string; count: number }>(
      `SELECT status, COUNT(*) AS count FROM adapter_outbox GROUP BY status`,
    ),
    safeQuery<{ name: string; connector_type: string; status: string }>(
      `SELECT name, connector_type, status FROM connectors ORDER BY name LIMIT 20`,
    ),
    safeQuery<{ name: string; applied_at: string }>(
      `SELECT name, applied_at FROM lilg_schema_migrations ORDER BY applied_at`,
    ),
  ]);

  const outbox: Record<string, number> = {};
  for (const row of queueDepth) {
    outbox[row.status.toLowerCase()] = Number(row.count) || 0;
  }

  const tables = [
    'employees', 'lilg_sessions', 'saml_service_providers', 'saml_assertion_log',
    'connectors', 'entitlements', 'business_roles', 'access_requests',
    'sod_policies', 'notifications', 'applications', 'oidc_clients',
  ];
  const tableStats: Record<string, number> = {};
  await Promise.all(tables.map(async (t) => {
    const row = await safeQueryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM \`${t}\``, []);
    tableStats[t] = row?.n ?? 0;
  }));

  res.json({
    db: { ok: dbOk, latency_ms: dbLatencyMs },
    redis: { ok: redisOk, latency_ms: redisLatencyMs },
    outbox,
    connectors: connectorRows,
    migrations,
    tableStats,
    uptime_seconds: Math.floor(process.uptime()),
  });
}));

export default router;
