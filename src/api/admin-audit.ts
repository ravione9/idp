/**
 * Admin audit log — SAML assertions, tamper-evident audit_log, auth attempts.
 * Supports date range, filters, pagination, and CSV export for compliance.
 */
import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { requireRole, requirePortalModule } from '../auth/rbac.js';
import { query, queryOne } from '../db/connection.js';
import { verifyChain } from '../utils/audit-log.js';
import { asyncHandler } from '../utils/async-handler.js';

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

  const [saml, audit, failed, success] = await Promise.all([
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
    },
  });
}));

export default router;
