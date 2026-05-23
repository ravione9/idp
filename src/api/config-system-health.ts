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

  // DB check
  let dbOk = false;
  try { await query('SELECT 1', []); dbOk = true; } catch { dbOk = false; }

  // Redis check
  let redisOk = false;
  try { const p = await redis.ping(); redisOk = p === 'PONG'; } catch { redisOk = false; }

  const [queueDepth, connectorRuns, migrations] = await Promise.all([
    safeQuery<{ status: string; count: number }>(
      `SELECT status, COUNT(*) AS count FROM adapter_outbox GROUP BY status`,
    ),
    safeQuery<Record<string, unknown>>(
      `SELECT * FROM connector_runs ORDER BY started_at DESC LIMIT 10`,
    ),
    safeQuery<{ name: string; applied_at: string }>(
      `SELECT name, applied_at FROM lilg_schema_migrations ORDER BY applied_at`,
    ),
  ]);

  // Table stats
  const tables = [
    'employees', 'idp_sessions', 'saml_service_providers', 'saml_assertion_log',
    'connectors', 'entitlements', 'business_roles', 'access_requests',
    'sod_policies', 'notifications', 'tickets', 'pam_resources',
  ];
  const tableStats: Record<string, number> = {};
  await Promise.all(tables.map(async (t) => {
    const row = await safeQueryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM \`${t}\``, []);
    tableStats[t] = row?.n ?? 0;
  }));

  res.json({
    db: dbOk,
    redis: redisOk,
    queueDepth,
    recentConnectorRuns: connectorRuns,
    migrations,
    tableStats,
    uptime: process.uptime(),
  });
}));

export default router;
