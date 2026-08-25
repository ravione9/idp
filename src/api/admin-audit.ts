/**
 * Admin audit log — SAML assertions, tamper-evident audit_log, auth attempts,
 * portal session audit.
 * Supports date range, filters, pagination, and CSV export for compliance.
 */
import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { requireRole, requirePortalModule } from '../auth/rbac.js';
import { query, queryOne, execute } from '../db/connection.js';
import { verifyChain } from '../utils/audit-log.js';
import { asyncHandler } from '../utils/async-handler.js';
import { redis } from '../auth/session-store.js';
import { SESSION_REDIS_PREFIX } from '../auth/session.js';
import logger from '../utils/logger.js';

const router = Router();

router.use(requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), requirePortalModule('reports'));

const MAX_LIMIT = 500;
const MAX_EXPORT = 10000;

function parseLimit(raw: unknown, fallback = 100): number {
  const n = parseInt(String(raw ?? fallback), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, MAX_LIMIT);
}

function parseOffset(raw: unknown): number {
  const n = parseInt(String(raw ?? '0'), 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function parseDateBound(raw: unknown, endOfDay: boolean): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const s = raw.trim();
  // Accept YYYY-MM-DD or ISO datetime
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return endOfDay ? `${s} 23:59:59` : `${s} 00:00:00`;
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) {
    return s.replace('T', ' ').slice(0, 19);
  }
  return null;
}

function csvEscape(value: unknown): string {
  const s = value == null ? '' : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

function sendCsv(res: Response, filename: string, headers: string[], rows: unknown[][]): void {
  const lines = [
    headers.map(csvEscape).join(','),
    ...rows.map((r) => r.map(csvEscape).join(',')),
  ];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(lines.join('\n'));
}

function daysAgoIso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// GET /saml  — SSO assertion log (filtered)
// ---------------------------------------------------------------------------
router.get('/saml', asyncHandler(async (req: Request, res: Response) => {
  const limit = parseLimit(req.query['limit']);
  const offset = parseOffset(req.query['offset']);
  const q = typeof req.query['q'] === 'string' ? req.query['q'].trim() : '';
  const app = typeof req.query['app'] === 'string' ? req.query['app'].trim() : '';
  const binding = typeof req.query['binding'] === 'string' ? req.query['binding'].trim() : '';
  const from = parseDateBound(req.query['from'], false);
  const to = parseDateBound(req.query['to'], true);
  const exportCsv = String(req.query['export'] || '') === 'csv';

  const where: string[] = ['1=1'];
  const params: unknown[] = [];

  if (from) { where.push('al.ts >= ?'); params.push(from); }
  if (to) { where.push('al.ts <= ?'); params.push(to); }
  if (binding) { where.push('al.binding = ?'); params.push(binding); }
  if (app) {
    where.push('(sp.name LIKE ? OR sp.slug LIKE ?)');
    params.push(`%${app}%`, `%${app}%`);
  }
  if (q) {
    where.push('(e.full_name LIKE ? OR e.email_corp LIKE ? OR al.emp_id LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }

  const whereSql = where.join(' AND ');

  const totalRow = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM saml_assertion_log al
       JOIN saml_service_providers sp ON sp.id = al.sp_id
       LEFT JOIN employees e ON e.emp_id = al.emp_id
      WHERE ${whereSql}`,
    params,
  ).catch(() => ({ n: 0 }));

  const fetchLimit = exportCsv ? Math.min(MAX_EXPORT, MAX_EXPORT) : limit;
  const fetchOffset = exportCsv ? 0 : offset;

  const rows = await query<Record<string, unknown>>(
    `SELECT al.id, al.ts, al.emp_id, al.binding, al.relay_state, al.request_id,
            sp.name AS sp_name, sp.slug AS sp_slug,
            e.full_name AS emp_name, e.email_corp AS emp_email
       FROM saml_assertion_log al
       JOIN saml_service_providers sp ON sp.id = al.sp_id
       LEFT JOIN employees e ON e.emp_id = al.emp_id
      WHERE ${whereSql}
      ORDER BY al.ts DESC
      LIMIT ? OFFSET ?`,
    [...params, fetchLimit, fetchOffset],
  ).catch(() => []);

  if (exportCsv) {
    sendCsv(
      res,
      `sso-assertions-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Time', 'Application', 'Slug', 'User', 'Email', 'Emp ID', 'Binding', 'Request ID', 'Relay State'],
      rows.map((r) => [
        r['ts'], r['sp_name'], r['sp_slug'], r['emp_name'], r['emp_email'],
        r['emp_id'], r['binding'], r['request_id'], r['relay_state'],
      ]),
    );
    return;
  }

  res.json({
    data: rows,
    meta: {
      total: Number(totalRow?.n ?? 0),
      limit,
      offset,
      from: from ?? null,
      to: to ?? null,
    },
  });
}));

// ---------------------------------------------------------------------------
// GET /system  — tamper-evident audit_log (filtered)
// ---------------------------------------------------------------------------
router.get('/system', asyncHandler(async (req: Request, res: Response) => {
  const limit = parseLimit(req.query['limit']);
  const offset = parseOffset(req.query['offset']);
  const q = typeof req.query['q'] === 'string' ? req.query['q'].trim() : '';
  const actor = typeof req.query['actor'] === 'string' ? req.query['actor'].trim() : '';
  const action = typeof req.query['action'] === 'string' ? req.query['action'].trim() : '';
  const from = parseDateBound(req.query['from'], false);
  const to = parseDateBound(req.query['to'], true);
  const exportCsv = String(req.query['export'] || '') === 'csv';

  const where: string[] = ['1=1'];
  const params: unknown[] = [];

  if (from) { where.push('ts >= ?'); params.push(from); }
  if (to) { where.push('ts <= ?'); params.push(to); }
  if (actor) { where.push('actor LIKE ?'); params.push(`%${actor}%`); }
  if (action) { where.push('action LIKE ?'); params.push(`%${action}%`); }
  if (q) {
    where.push('(target LIKE ? OR actor LIKE ? OR action LIKE ? OR CAST(payload AS CHAR) LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }

  const whereSql = where.join(' AND ');

  const totalRow = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM audit_log WHERE ${whereSql}`,
    params,
  ).catch(() => ({ n: 0 }));

  const fetchLimit = exportCsv ? MAX_EXPORT : limit;
  const fetchOffset = exportCsv ? 0 : offset;

  const rows = await query<Record<string, unknown>>(
    `SELECT id, ts, actor, action, target, payload, prev_hash, curr_hash
       FROM audit_log
      WHERE ${whereSql}
      ORDER BY ts DESC
      LIMIT ? OFFSET ?`,
    [...params, fetchLimit, fetchOffset],
  ).catch(() => []);

  if (exportCsv) {
    sendCsv(
      res,
      `system-audit-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Time', 'Actor', 'Action', 'Target', 'Payload', 'Prev Hash', 'Curr Hash'],
      rows.map((r) => [
        r['ts'], r['actor'], r['action'], r['target'],
        typeof r['payload'] === 'string' ? r['payload'] : JSON.stringify(r['payload'] ?? {}),
        r['prev_hash'], r['curr_hash'],
      ]),
    );
    return;
  }

  res.json({
    data: rows,
    meta: {
      total: Number(totalRow?.n ?? 0),
      limit,
      offset,
      from: from ?? null,
      to: to ?? null,
    },
  });
}));

// ---------------------------------------------------------------------------
// GET /auth-attempts  — low-level login forensics
// ---------------------------------------------------------------------------
router.get('/auth-attempts', asyncHandler(async (req: Request, res: Response) => {
  const limit = parseLimit(req.query['limit']);
  const offset = parseOffset(req.query['offset']);
  const q = typeof req.query['q'] === 'string' ? req.query['q'].trim() : '';
  const ip = typeof req.query['ip'] === 'string' ? req.query['ip'].trim() : '';
  const successRaw = typeof req.query['success'] === 'string' ? req.query['success'].trim() : '';
  const reason = typeof req.query['reason'] === 'string' ? req.query['reason'].trim() : '';
  const from = parseDateBound(req.query['from'], false);
  const to = parseDateBound(req.query['to'], true);
  const exportCsv = String(req.query['export'] || '') === 'csv';

  const where: string[] = ['1=1'];
  const params: unknown[] = [];

  if (from) { where.push('ts >= ?'); params.push(from); }
  if (to) { where.push('ts <= ?'); params.push(to); }
  if (ip) { where.push('ip LIKE ?'); params.push(`%${ip}%`); }
  if (reason) { where.push('reason LIKE ?'); params.push(`%${reason}%`); }
  if (successRaw === '1' || successRaw === '0') {
    where.push('success = ?');
    params.push(Number(successRaw));
  }
  if (q) { where.push('email LIKE ?'); params.push(`%${q}%`); }

  const whereSql = where.join(' AND ');

  const totalRow = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM auth_attempts WHERE ${whereSql}`,
    params,
  ).catch(() => ({ n: 0 }));

  const fetchLimit = exportCsv ? MAX_EXPORT : limit;
  const fetchOffset = exportCsv ? 0 : offset;

  const rows = await query<Record<string, unknown>>(
    `SELECT id, email, ip, success, reason, ts
       FROM auth_attempts
      WHERE ${whereSql}
      ORDER BY ts DESC
      LIMIT ? OFFSET ?`,
    [...params, fetchLimit, fetchOffset],
  ).catch(() => []);

  if (exportCsv) {
    sendCsv(
      res,
      `auth-attempts-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Time', 'Email', 'IP', 'Success', 'Reason'],
      rows.map((r) => [r['ts'], r['email'], r['ip'], r['success'] ? '1' : '0', r['reason']]),
    );
    return;
  }

  res.json({
    data: rows,
    meta: {
      total: Number(totalRow?.n ?? 0),
      limit,
      offset,
      from: from ?? null,
      to: to ?? null,
    },
  });
}));

// ---------------------------------------------------------------------------
// GET /sessions — portal session audit (active / revoked / expired)
// ---------------------------------------------------------------------------
router.get('/sessions', asyncHandler(async (req: Request, res: Response) => {
  const limit = parseLimit(req.query['limit']);
  const offset = parseOffset(req.query['offset']);
  const q = typeof req.query['q'] === 'string' ? req.query['q'].trim() : '';
  const ip = typeof req.query['ip'] === 'string' ? req.query['ip'].trim() : '';
  const iss = typeof req.query['iss'] === 'string' ? req.query['iss'].trim() : '';
  const status = typeof req.query['status'] === 'string' ? req.query['status'].trim().toLowerCase() : '';
  const from = parseDateBound(req.query['from'], false);
  const to = parseDateBound(req.query['to'], true);
  const exportCsv = String(req.query['export'] || '') === 'csv';

  const where: string[] = ['1=1'];
  const params: unknown[] = [];

  if (from) { where.push('s.created_at >= ?'); params.push(from); }
  if (to) { where.push('s.created_at <= ?'); params.push(to); }
  if (ip) { where.push('s.ip LIKE ?'); params.push(`%${ip}%`); }
  if (iss) { where.push('s.iss = ?'); params.push(iss); }
  if (q) {
    where.push('(s.email LIKE ? OR s.emp_id LIKE ? OR e.full_name LIKE ? OR e.email_corp LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (status === 'active') {
    where.push('s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP()');
  } else if (status === 'revoked') {
    where.push('s.revoked_at IS NOT NULL');
  } else if (status === 'expired') {
    where.push('s.revoked_at IS NULL AND s.expires_at <= UTC_TIMESTAMP()');
  }

  const whereSql = where.join(' AND ');

  const totalRow = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM idp_sessions s
       LEFT JOIN employees e ON e.emp_id = s.emp_id
      WHERE ${whereSql}`,
    params,
  ).catch(() => ({ n: 0 }));

  const fetchLimit = exportCsv ? MAX_EXPORT : limit;
  const fetchOffset = exportCsv ? 0 : offset;

  const rows = await query<Record<string, unknown>>(
    `SELECT s.session_id, s.emp_id, s.email, s.role, s.iss, s.sub,
            s.created_at, s.last_active_at, s.expires_at, s.revoked_at,
            s.ip, s.user_agent, s.device_info, s.geo_location,
            e.full_name AS emp_name, e.email_corp AS emp_email,
            CASE
              WHEN s.revoked_at IS NOT NULL THEN 'revoked'
              WHEN s.expires_at <= UTC_TIMESTAMP() THEN 'expired'
              ELSE 'active'
            END AS status,
            TIMESTAMPDIFF(
              MINUTE,
              s.created_at,
              COALESCE(s.revoked_at, LEAST(s.last_active_at, UTC_TIMESTAMP()), UTC_TIMESTAMP())
            ) AS duration_minutes
       FROM idp_sessions s
       LEFT JOIN employees e ON e.emp_id = s.emp_id
      WHERE ${whereSql}
      ORDER BY s.created_at DESC
      LIMIT ? OFFSET ?`,
    [...params, fetchLimit, fetchOffset],
  ).catch(() => []);

  if (exportCsv) {
    sendCsv(
      res,
      `sessions-${new Date().toISOString().slice(0, 10)}.csv`,
      [
        'Created', 'Last active', 'Expires', 'Revoked', 'Status', 'Duration (min)',
        'Emp ID', 'Name', 'Email', 'Role', 'Issuer', 'IP', 'Device', 'Geo', 'User-Agent', 'Session ID',
      ],
      rows.map((r) => [
        r['created_at'], r['last_active_at'], r['expires_at'], r['revoked_at'],
        r['status'], r['duration_minutes'],
        r['emp_id'], r['emp_name'], r['email'] || r['emp_email'], r['role'], r['iss'],
        r['ip'], r['device_info'], r['geo_location'], r['user_agent'], r['session_id'],
      ]),
    );
    return;
  }

  res.json({
    data: rows,
    meta: {
      total: Number(totalRow?.n ?? 0),
      limit,
      offset,
      from: from ?? null,
      to: to ?? null,
    },
  });
}));

// POST /sessions/:id/revoke — admin force-logout
router.post('/sessions/:id/revoke', asyncHandler(async (req: Request, res: Response) => {
  const sessionId = req.params['id']!;
  const row = await queryOne<{ session_id: string; revoked_at: Date | null; emp_id: string }>(
    `SELECT session_id, revoked_at, emp_id FROM idp_sessions WHERE session_id = ? LIMIT 1`,
    [sessionId],
  );
  if (!row) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  if (row.revoked_at) {
    res.json({ success: true, alreadyRevoked: true });
    return;
  }

  await execute(
    `UPDATE idp_sessions SET revoked_at = UTC_TIMESTAMP() WHERE session_id = ? AND revoked_at IS NULL`,
    [sessionId],
  );
  await redis.del(`${SESSION_REDIS_PREFIX}${sessionId}`).catch(() => undefined);

  const actor = (req as unknown as { user?: { empId?: string } }).user?.empId ?? 'admin';
  logger.info({ sessionId, empId: row.emp_id, by: actor }, 'Admin revoked portal session');
  res.json({ success: true });
}));

// ---------------------------------------------------------------------------
// GET /integrity — verify tamper-evident hash chain
// ---------------------------------------------------------------------------
router.get('/integrity', asyncHandler(async (req: Request, res: Response) => {
  const limit = Math.min(parseLimit(req.query['limit'], 1000), 5000);
  const result = await verifyChain(limit);
  res.json({ data: result });
}));

// ---------------------------------------------------------------------------
// GET /summary — compliance snapshot counters for a date window
// ---------------------------------------------------------------------------
router.get('/summary', asyncHandler(async (req: Request, res: Response) => {
  const daysRaw = parseInt(String(req.query['days'] ?? '30'), 10);
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 365) : 30;
  const from = parseDateBound(req.query['from'], false) ?? `${daysAgoIso(days)} 00:00:00`;
  const to = parseDateBound(req.query['to'], true);

  const toClause = to ? 'AND ts <= ?' : '';
  const samlParams = to ? [from, to] : [from];
  const auditParams = to ? [from, to] : [from];
  const authParams = to ? [from, to] : [from];
  const sessToClause = to ? 'AND created_at <= ?' : '';
  const sessParams = to ? [from, to] : [from];

  const [saml, audit, failed, success, sessionsCreated, sessionsActive] = await Promise.all([
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM saml_assertion_log WHERE ts >= ? ${toClause}`,
      samlParams,
    ).catch(() => ({ n: 0 })),
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_log WHERE ts >= ? ${toClause}`,
      auditParams,
    ).catch(() => ({ n: 0 })),
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM auth_attempts WHERE success = 0 AND ts >= ? ${toClause}`,
      authParams,
    ).catch(() => ({ n: 0 })),
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM auth_attempts WHERE success = 1 AND ts >= ? ${toClause}`,
      authParams,
    ).catch(() => ({ n: 0 })),
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM idp_sessions WHERE created_at >= ? ${sessToClause}`,
      sessParams,
    ).catch(() => ({ n: 0 })),
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM idp_sessions
        WHERE revoked_at IS NULL AND expires_at > UTC_TIMESTAMP()`,
      [],
    ).catch(() => ({ n: 0 })),
  ]);

  res.json({
    data: {
      from,
      to: to ?? null,
      days,
      ssoAssertions: Number(saml?.n ?? 0),
      systemAuditEvents: Number(audit?.n ?? 0),
      failedLogins: Number(failed?.n ?? 0),
      successfulLogins: Number(success?.n ?? 0),
      sessionsCreated: Number(sessionsCreated?.n ?? 0),
      sessionsActive: Number(sessionsActive?.n ?? 0),
    },
  });
}));

// ---------------------------------------------------------------------------
// GET /app-provisioning — application user provision / deprovision log
// ---------------------------------------------------------------------------
router.get('/app-provisioning', asyncHandler(async (req: Request, res: Response) => {
  const limit = parseLimit(req.query['limit']);
  const offset = parseOffset(req.query['offset']);
  const q = typeof req.query['q'] === 'string' ? req.query['q'].trim() : '';
  const app = typeof req.query['app'] === 'string' ? req.query['app'].trim() : '';
  const action = typeof req.query['action'] === 'string' ? req.query['action'].trim().toUpperCase() : '';
  const status = typeof req.query['status'] === 'string' ? req.query['status'].trim().toUpperCase() : '';
  const from = parseDateBound(req.query['from'], false);
  const to = parseDateBound(req.query['to'], true);
  const exportCsv = String(req.query['export'] || '') === 'csv';

  const where: string[] = ['1=1'];
  const params: unknown[] = [];

  if (from) { where.push('l.created_at >= ?'); params.push(from); }
  if (to) { where.push('l.created_at <= ?'); params.push(to); }
  if (action === 'PROVISION' || action === 'DEPROVISION') {
    where.push('l.action = ?');
    params.push(action);
  }
  if (status === 'SUCCESS' || status === 'FAILED' || status === 'SKIPPED') {
    where.push('l.status = ?');
    params.push(status);
  }
  if (app) {
    where.push('(a.name LIKE ? OR a.slug LIKE ?)');
    params.push(`%${app}%`, `%${app}%`);
  }
  if (q) {
    where.push(
      '(e.full_name LIKE ? OR e.email_corp LIKE ? OR l.emp_id LIKE ? OR l.endpoint LIKE ? OR l.detail LIKE ?)',
    );
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }

  const whereSql = where.join(' AND ');

  const totalRow = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM app_provision_log l
       LEFT JOIN applications a ON a.id = l.app_id
       LEFT JOIN employees e ON e.emp_id = l.emp_id
      WHERE ${whereSql}`,
    params,
  ).catch(() => ({ n: 0 }));

  const fetchLimit = exportCsv ? MAX_EXPORT : limit;
  const fetchOffset = exportCsv ? 0 : offset;

  const rows = await query<Record<string, unknown>>(
    `SELECT l.id, l.created_at, l.action, l.source, l.http_method, l.endpoint,
            l.status, l.status_code, l.detail, l.request_body, l.response_body,
            l.emp_id, l.actor_emp_id, l.request_id,
            a.name AS app_name, a.slug AS app_slug,
            e.full_name AS emp_name, e.email_corp AS emp_email,
            act.full_name AS actor_name
       FROM app_provision_log l
       LEFT JOIN applications a ON a.id = l.app_id
       LEFT JOIN employees e ON e.emp_id = l.emp_id
       LEFT JOIN employees act ON act.emp_id = l.actor_emp_id
      WHERE ${whereSql}
      ORDER BY l.created_at DESC
      LIMIT ? OFFSET ?`,
    [...params, fetchLimit, fetchOffset],
  ).catch(() => []);

  if (exportCsv) {
    sendCsv(
      res,
      `app-provisioning-${new Date().toISOString().slice(0, 10)}.csv`,
      [
        'Time', 'Action', 'Status', 'Application', 'Slug', 'User', 'Email', 'Emp ID',
        'HTTP Method', 'Endpoint', 'Status Code', 'Source', 'Actor', 'Detail',
        'Request Body', 'Response Body', 'Request ID',
      ],
      rows.map((r) => [
        r['created_at'], r['action'], r['status'], r['app_name'], r['app_slug'],
        r['emp_name'], r['emp_email'], r['emp_id'],
        r['http_method'], r['endpoint'], r['status_code'], r['source'], r['actor_name'] || r['actor_emp_id'],
        r['detail'],
        typeof r['request_body'] === 'string' ? r['request_body'] : JSON.stringify(r['request_body'] ?? ''),
        typeof r['response_body'] === 'string' ? r['response_body'] : JSON.stringify(r['response_body'] ?? ''),
        r['request_id'],
      ]),
    );
    return;
  }

  res.json({
    data: rows,
    meta: {
      total: Number(totalRow?.n ?? 0),
      limit,
      offset,
      from: from ?? null,
      to: to ?? null,
    },
  });
}));

export default router;
