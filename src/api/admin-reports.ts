/**
 * Enterprise reporting APIs — executive overview + governance report catalog.
 * Mounted at /api/admin/reports
 */
import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { requireRole, requirePortalModule } from '../auth/rbac.js';
import { query, queryOne } from '../db/connection.js';
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
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return endOfDay ? `${s} 23:59:59` : `${s} 00:00:00`;
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) {
    return s.replace('T', ' ').slice(0, 19);
  }
  return null;
}

function daysAgoBound(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return `${d.toISOString().slice(0, 10)} 00:00:00`;
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

function wantCsv(req: Request): boolean {
  return String(req.query['export'] || '') === 'csv';
}

// ---------------------------------------------------------------------------
// GET /overview — executive KPIs + trends for Reports Hub
// ---------------------------------------------------------------------------
router.get('/overview', asyncHandler(async (req: Request, res: Response) => {
  const daysRaw = parseInt(String(req.query['days'] ?? '30'), 10);
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 365) : 30;
  const from = parseDateBound(req.query['from'], false) || daysAgoBound(days);
  const to = parseDateBound(req.query['to'], true);

  const toSql = to ? 'AND ts <= ?' : '';
  const toSqlAl = to ? 'AND al.ts <= ?' : '';
  const rangeParams = to ? [from, to] : [from];

  const [
    activeUsers,
    mfaTotp,
    mfaAnyMethod,
    failedLogins,
    ssoAssertions,
    openSod,
    pendingRequests,
    pendingReviews,
    activeSessions,
    dormant,
    loginSeries,
    ssoSeries,
    failSeries,
    topApps,
    requestStatus,
    reviewCampaigns,
    accessGrants,
  ] = await Promise.all([
    queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM employees WHERE ilg_state = 'ACTIVE'", []),
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM mfa_secrets ms
       INNER JOIN employees e ON e.emp_id = ms.emp_id
       WHERE ms.enabled = 1 AND e.ilg_state = 'ACTIVE'`,
      [],
    ),
    queryOne<{ n: number }>(
      `SELECT COUNT(DISTINCT e.emp_id) AS n FROM employees e
       WHERE e.ilg_state = 'ACTIVE'
         AND (
           EXISTS (SELECT 1 FROM mfa_secrets ms WHERE ms.emp_id = e.emp_id AND ms.enabled = 1)
           OR EXISTS (SELECT 1 FROM mfa_method_enrollments me WHERE me.emp_id = e.emp_id AND me.enabled = 1)
           OR EXISTS (SELECT 1 FROM webauthn_credentials wc WHERE wc.emp_id = e.emp_id)
         )`,
      [],
    ),
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM auth_attempts WHERE success = 0 AND ts >= ? ${toSql}`,
      rangeParams,
    ),
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM saml_assertion_log al WHERE al.ts >= ? ${toSqlAl}`,
      rangeParams,
    ),
    queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM sod_violations WHERE status = 'OPEN'", []),
    queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM access_requests WHERE status = 'PENDING'", []),
    queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM access_review_items WHERE decision = 'PENDING'", []),
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM idp_sessions
       WHERE revoked_at IS NULL AND expires_at > NOW()`,
      [],
    ),
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM (
         SELECT e.emp_id
         FROM employees e
         LEFT JOIN idp_sessions s ON s.emp_id = e.emp_id
         WHERE e.ilg_state = 'ACTIVE'
         GROUP BY e.emp_id
         HAVING MAX(s.last_active_at) IS NULL OR MAX(s.last_active_at) < ?
       ) d`,
      [from],
    ),
    query<{ d: string; n: number }>(
      `SELECT DATE(ts) AS d, COUNT(*) AS n FROM auth_attempts
       WHERE success = 1 AND ts >= ? ${toSql}
       GROUP BY DATE(ts) ORDER BY d`,
      rangeParams,
    ),
    query<{ d: string; n: number }>(
      `SELECT DATE(al.ts) AS d, COUNT(*) AS n FROM saml_assertion_log al
       WHERE al.ts >= ? ${toSqlAl}
       GROUP BY DATE(al.ts) ORDER BY d`,
      rangeParams,
    ),
    query<{ d: string; n: number }>(
      `SELECT DATE(ts) AS d, COUNT(*) AS n FROM auth_attempts
       WHERE success = 0 AND ts >= ? ${toSql}
       GROUP BY DATE(ts) ORDER BY d`,
      rangeParams,
    ),
    query<{ name: string; slug: string; n: number }>(
      `SELECT sp.name, sp.slug, COUNT(al.id) AS n
       FROM saml_assertion_log al
       INNER JOIN saml_service_providers sp ON sp.id = al.sp_id
       WHERE al.ts >= ? ${toSqlAl}
       GROUP BY sp.id, sp.name, sp.slug
       ORDER BY n DESC LIMIT 10`,
      rangeParams,
    ),
    query<{ status: string; n: number }>(
      `SELECT status, COUNT(*) AS n FROM access_requests
       WHERE created_at >= ? ${to ? 'AND created_at <= ?' : ''}
       GROUP BY status`,
      rangeParams,
    ),
    query<{
      id: string; name: string; status: string; total: number; pending: number;
      certified: number; revoked: number; start_date: string; end_date: string;
    }>(
      `SELECT c.id, c.name, c.status, c.start_date, c.end_date,
              COUNT(i.id) AS total,
              SUM(CASE WHEN i.decision = 'PENDING' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN i.decision = 'CERTIFY' THEN 1 ELSE 0 END) AS certified,
              SUM(CASE WHEN i.decision = 'REVOKE' THEN 1 ELSE 0 END) AS revoked
       FROM access_review_campaigns c
       LEFT JOIN access_review_items i ON i.campaign_id = c.id
       GROUP BY c.id, c.name, c.status, c.start_date, c.end_date
       ORDER BY c.start_date DESC
       LIMIT 8`,
      [],
    ),
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM app_access_assignments WHERE active = 1 AND revoked_at IS NULL`,
      [],
    ),
  ]);

  const active = Number(activeUsers?.n ?? 0);
  const mfaCovered = Number(mfaAnyMethod?.n ?? 0);

  res.json({
    data: {
      kpis: {
        activeUsers: active,
        mfaCovered,
        mfaCoveragePct: active > 0 ? Math.round((mfaCovered / active) * 100) : 0,
        mfaTotpOnly: Number(mfaTotp?.n ?? 0),
        failedLogins: Number(failedLogins?.n ?? 0),
        ssoAssertions: Number(ssoAssertions?.n ?? 0),
        openSodViolations: Number(openSod?.n ?? 0),
        pendingAccessRequests: Number(pendingRequests?.n ?? 0),
        pendingReviewItems: Number(pendingReviews?.n ?? 0),
        activeSessions: Number(activeSessions?.n ?? 0),
        dormantUsers: Number(dormant?.n ?? 0),
        activeAppAssignments: Number(accessGrants?.n ?? 0),
      },
      series: {
        logins: loginSeries.map((r) => ({ d: String(r.d).slice(0, 10), n: Number(r.n) })),
        sso: ssoSeries.map((r) => ({ d: String(r.d).slice(0, 10), n: Number(r.n) })),
        failed: failSeries.map((r) => ({ d: String(r.d).slice(0, 10), n: Number(r.n) })),
      },
      topApps: topApps.map((r) => ({ name: r.name, slug: r.slug, n: Number(r.n) })),
      accessRequestsByStatus: requestStatus.map((r) => ({ status: r.status, n: Number(r.n) })),
      certificationCampaigns: reviewCampaigns.map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        startDate: r.start_date,
        endDate: r.end_date,
        total: Number(r.total),
        pending: Number(r.pending),
        certified: Number(r.certified),
        revoked: Number(r.revoked),
        completionPct: Number(r.total) > 0
          ? Math.round(((Number(r.total) - Number(r.pending)) / Number(r.total)) * 100)
          : 0,
      })),
    },
    meta: { from, to, days },
  });
}));

// ---------------------------------------------------------------------------
// GET /access-inventory — who has what (apps, roles, entitlements)
// ---------------------------------------------------------------------------
router.get('/access-inventory', asyncHandler(async (req: Request, res: Response) => {
  const limit = wantCsv(req) ? MAX_EXPORT : parseLimit(req.query['limit']);
  const offset = wantCsv(req) ? 0 : parseOffset(req.query['offset']);
  const q = typeof req.query['q'] === 'string' ? req.query['q'].trim() : '';
  const kind = typeof req.query['kind'] === 'string' ? req.query['kind'].trim().toUpperCase() : '';
  const dept = typeof req.query['department'] === 'string' ? req.query['department'].trim() : '';

  const where: string[] = ['1=1'];
  const params: unknown[] = [];

  if (kind === 'APP' || kind === 'ROLE' || kind === 'ENTITLEMENT') {
    where.push('access_kind = ?');
    params.push(kind);
  }
  if (q) {
    where.push('(emp_name LIKE ? OR emp_email LIKE ? OR emp_id LIKE ? OR access_name LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (dept) {
    where.push('department LIKE ?');
    params.push(`%${dept}%`);
  }

  const unionSql = `
    SELECT * FROM (
      SELECT e.emp_id, e.full_name AS emp_name, e.email_corp AS emp_email, e.dept_id AS department,
             e.ilg_state, 'APP' AS access_kind, a.name AS access_name, a.slug AS access_ref,
             aa.assignment_type AS source, aa.granted_at, aa.granted_by, NULL AS expires_at
      FROM app_access_assignments aa
      INNER JOIN applications a ON a.id = aa.app_id
      INNER JOIN employees e ON e.emp_id = aa.target_id
      WHERE aa.active = 1 AND aa.revoked_at IS NULL AND aa.assignment_type = 'USER'
        AND e.ilg_state IN ('ACTIVE','SUSPENDED')

      UNION ALL

      SELECT e.emp_id, e.full_name, e.email_corp, e.dept_id AS department, e.ilg_state,
             'APP', a.name, a.slug, 'TAG_GROUP', aa.granted_at, aa.granted_by, NULL
      FROM app_access_assignments aa
      INNER JOIN applications a ON a.id = aa.app_id
      INNER JOIN tag_group_members tgm ON tgm.tag_group_id = aa.target_id
      INNER JOIN employees e ON e.emp_id = tgm.emp_id
      WHERE aa.active = 1 AND aa.revoked_at IS NULL AND aa.assignment_type = 'TAG_GROUP'
        AND e.ilg_state IN ('ACTIVE','SUSPENDED')

      UNION ALL

      SELECT e.emp_id, e.full_name, e.email_corp, e.dept_id AS department, e.ilg_state,
             'ROLE', br.name, br.slug, 'ROLE', ur.granted_at, ur.granted_by, ur.expires_at
      FROM user_roles ur
      INNER JOIN business_roles br ON br.id = ur.role_id
      INNER JOIN employees e ON e.emp_id = ur.emp_id
      WHERE e.ilg_state IN ('ACTIVE','SUSPENDED')
        AND (ur.expires_at IS NULL OR ur.expires_at > NOW())

      UNION ALL

      SELECT e.emp_id, e.full_name, e.email_corp, e.dept_id AS department, e.ilg_state,
             'ENTITLEMENT', ent.name, ent.id, ue.source, ue.granted_at, ue.granted_by, ue.expires_at
      FROM user_entitlements ue
      INNER JOIN entitlements ent ON ent.id = ue.entitlement_id
      INNER JOIN employees e ON e.emp_id = ue.emp_id
      WHERE ue.revoked_at IS NULL
        AND e.ilg_state IN ('ACTIVE','SUSPENDED')
        AND (ue.expires_at IS NULL OR ue.expires_at > NOW())
    ) inv
    WHERE ${where.join(' AND ')}
  `;

  const totalRow = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM (${unionSql}) c`,
    params,
  );

  const rows = await query<{
    emp_id: string; emp_name: string; emp_email: string; department: string | null;
    ilg_state: string; access_kind: string; access_name: string; access_ref: string;
    source: string; granted_at: string; granted_by: string | null; expires_at: string | null;
  }>(
    `${unionSql} ORDER BY emp_name, access_kind, access_name LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  if (wantCsv(req)) {
    return sendCsv(
      res,
      'access-inventory.csv',
      ['Emp ID', 'Name', 'Email', 'Department', 'State', 'Kind', 'Access', 'Ref', 'Source', 'Granted At', 'Granted By', 'Expires At'],
      rows.map((r) => [
        r.emp_id, r.emp_name, r.emp_email, r.department, r.ilg_state,
        r.access_kind, r.access_name, r.access_ref, r.source,
        r.granted_at, r.granted_by, r.expires_at,
      ]),
    );
  }

  res.json({
    data: rows,
    meta: { total: Number(totalRow?.n ?? 0), limit, offset },
  });
}));

// ---------------------------------------------------------------------------
// GET /mfa-coverage — MFA enrollment posture for active users
// ---------------------------------------------------------------------------
router.get('/mfa-coverage', asyncHandler(async (req: Request, res: Response) => {
  const limit = wantCsv(req) ? MAX_EXPORT : parseLimit(req.query['limit']);
  const offset = wantCsv(req) ? 0 : parseOffset(req.query['offset']);
  const q = typeof req.query['q'] === 'string' ? req.query['q'].trim() : '';
  const enrolled = typeof req.query['enrolled'] === 'string' ? req.query['enrolled'].trim() : '';

  const where: string[] = ["e.ilg_state = 'ACTIVE'"];
  const params: unknown[] = [];
  if (q) {
    where.push('(e.full_name LIKE ? OR e.email_corp LIKE ? OR e.emp_id LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }

  const enrolledExpr = `(
    CASE WHEN ms.enabled = 1 THEN 1 ELSE 0 END
    + CASE WHEN COALESCE(me.methods_enabled, 0) > 0 THEN 1 ELSE 0 END
    + CASE WHEN COALESCE(wc.creds, 0) > 0 THEN 1 ELSE 0 END
  ) > 0`;

  if (enrolled === '1' || enrolled === 'true') where.push(enrolledExpr);
  if (enrolled === '0' || enrolled === 'false') where.push(`NOT (${enrolledExpr})`);

  const fromSql = `
    FROM employees e
    LEFT JOIN mfa_secrets ms ON ms.emp_id = e.emp_id
    LEFT JOIN (
      SELECT emp_id, SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS methods_enabled,
             GROUP_CONCAT(CASE WHEN enabled = 1 THEN method END ORDER BY method SEPARATOR ',') AS methods
      FROM mfa_method_enrollments
      GROUP BY emp_id
    ) me ON me.emp_id = e.emp_id
    LEFT JOIN (
      SELECT emp_id, COUNT(*) AS creds FROM webauthn_credentials GROUP BY emp_id
    ) wc ON wc.emp_id = e.emp_id
    WHERE ${where.join(' AND ')}
  `;

  const totalRow = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n ${fromSql}`, params);
  const summary = await queryOne<{ total: number; covered: number }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN ${enrolledExpr} THEN 1 ELSE 0 END) AS covered
     FROM employees e
     LEFT JOIN mfa_secrets ms ON ms.emp_id = e.emp_id
     LEFT JOIN (
       SELECT emp_id, SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS methods_enabled
       FROM mfa_method_enrollments GROUP BY emp_id
     ) me ON me.emp_id = e.emp_id
     LEFT JOIN (
       SELECT emp_id, COUNT(*) AS creds FROM webauthn_credentials GROUP BY emp_id
     ) wc ON wc.emp_id = e.emp_id
     WHERE e.ilg_state = 'ACTIVE'`,
    [],
  );

  const rows = await query<{
    emp_id: string; full_name: string; email_corp: string; department: string | null;
    totp_enabled: number; methods: string | null; webauthn_creds: number;
    enrolled_at: string | null; last_used_at: string | null;
  }>(
    `SELECT e.emp_id, e.full_name, e.email_corp, e.dept_id AS department,
            COALESCE(ms.enabled, 0) AS totp_enabled,
            me.methods,
            COALESCE(wc.creds, 0) AS webauthn_creds,
            ms.enrolled_at, ms.last_used_at
     ${fromSql}
     ORDER BY e.full_name
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  const mapped = rows.map((r) => {
    const methods = [
      Number(r.totp_enabled) ? 'totp' : null,
      ...(r.methods ? String(r.methods).split(',').filter(Boolean) : []),
      Number(r.webauthn_creds) > 0 ? 'webauthn' : null,
    ].filter(Boolean);
    return {
      emp_id: r.emp_id,
      full_name: r.full_name,
      email_corp: r.email_corp,
      department: r.department,
      enrolled: methods.length > 0,
      methods: [...new Set(methods)],
      totp_enabled: !!Number(r.totp_enabled),
      webauthn_creds: Number(r.webauthn_creds),
      enrolled_at: r.enrolled_at,
      last_used_at: r.last_used_at,
    };
  });

  if (wantCsv(req)) {
    return sendCsv(
      res,
      'mfa-coverage.csv',
      ['Emp ID', 'Name', 'Email', 'Department', 'Enrolled', 'Methods', 'TOTP', 'WebAuthn Creds', 'Enrolled At', 'Last Used'],
      mapped.map((r) => [
        r.emp_id, r.full_name, r.email_corp, r.department,
        r.enrolled ? 'yes' : 'no', r.methods.join('|'),
        r.totp_enabled ? 'yes' : 'no', r.webauthn_creds,
        r.enrolled_at, r.last_used_at,
      ]),
    );
  }

  const totalActive = Number(summary?.total ?? 0);
  const covered = Number(summary?.covered ?? 0);

  res.json({
    data: mapped,
    meta: {
      total: Number(totalRow?.n ?? 0),
      limit,
      offset,
      summary: {
        activeUsers: totalActive,
        covered,
        coveragePct: totalActive > 0 ? Math.round((covered / totalActive) * 100) : 0,
        gaps: Math.max(0, totalActive - covered),
      },
    },
  });
}));

// ---------------------------------------------------------------------------
// GET /lifecycle — joiner/mover/leaver evidence
// ---------------------------------------------------------------------------
router.get('/lifecycle', asyncHandler(async (req: Request, res: Response) => {
  const limit = wantCsv(req) ? MAX_EXPORT : parseLimit(req.query['limit']);
  const offset = wantCsv(req) ? 0 : parseOffset(req.query['offset']);
  const from = parseDateBound(req.query['from'], false);
  const to = parseDateBound(req.query['to'], true);
  const q = typeof req.query['q'] === 'string' ? req.query['q'].trim() : '';
  const eventType = typeof req.query['eventType'] === 'string' ? req.query['eventType'].trim().toUpperCase() : '';

  const where: string[] = ['1=1'];
  const params: unknown[] = [];
  if (from) { where.push('le.ts >= ?'); params.push(from); }
  if (to) { where.push('le.ts <= ?'); params.push(to); }
  if (eventType) { where.push('le.event_type = ?'); params.push(eventType); }
  if (q) {
    where.push('(e.full_name LIKE ? OR e.email_corp LIKE ? OR le.emp_id LIKE ? OR le.initiated_by LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const whereSql = where.join(' AND ');

  const totalRow = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM lifecycle_events le
     LEFT JOIN employees e ON e.emp_id = le.emp_id
     WHERE ${whereSql}`,
    params,
  );

  const rows = await query<{
    id: number; emp_id: string; full_name: string | null; email_corp: string | null;
    event_type: string; old_state: string | null; new_state: string | null;
    reason: string | null; initiated_by: string; ts: string;
  }>(
    `SELECT le.id, le.emp_id, e.full_name, e.email_corp, le.event_type,
            le.old_state, le.new_state, le.reason, le.initiated_by, le.ts
     FROM lifecycle_events le
     LEFT JOIN employees e ON e.emp_id = le.emp_id
     WHERE ${whereSql}
     ORDER BY le.ts DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  if (wantCsv(req)) {
    return sendCsv(
      res,
      'lifecycle-events.csv',
      ['ID', 'Emp ID', 'Name', 'Email', 'Event', 'Old State', 'New State', 'Reason', 'Initiated By', 'Timestamp'],
      rows.map((r) => [
        r.id, r.emp_id, r.full_name, r.email_corp, r.event_type,
        r.old_state, r.new_state, r.reason, r.initiated_by, r.ts,
      ]),
    );
  }

  res.json({ data: rows, meta: { total: Number(totalRow?.n ?? 0), limit, offset, from, to } });
}));

// ---------------------------------------------------------------------------
// GET /access-requests — request volume, SLA, outcomes
// ---------------------------------------------------------------------------
router.get('/access-requests', asyncHandler(async (req: Request, res: Response) => {
  const limit = wantCsv(req) ? MAX_EXPORT : parseLimit(req.query['limit']);
  const offset = wantCsv(req) ? 0 : parseOffset(req.query['offset']);
  const from = parseDateBound(req.query['from'], false);
  const to = parseDateBound(req.query['to'], true);
  const status = typeof req.query['status'] === 'string' ? req.query['status'].trim().toUpperCase() : '';
  const q = typeof req.query['q'] === 'string' ? req.query['q'].trim() : '';

  const where: string[] = ['1=1'];
  const params: unknown[] = [];
  if (from) { where.push('ar.created_at >= ?'); params.push(from); }
  if (to) { where.push('ar.created_at <= ?'); params.push(to); }
  if (status) { where.push('ar.status = ?'); params.push(status); }
  if (q) {
    where.push('(req.full_name LIKE ? OR req.email_corp LIKE ? OR tgt.full_name LIKE ? OR tgt.email_corp LIKE ? OR ar.id LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const whereSql = where.join(' AND ');

  const totalRow = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM access_requests ar
     LEFT JOIN employees req ON req.emp_id = ar.requester_emp_id
     LEFT JOIN employees tgt ON tgt.emp_id = ar.target_emp_id
     WHERE ${whereSql}`,
    params,
  );

  const summary = await query<{ status: string; n: number; overdue: number }>(
    `SELECT ar.status, COUNT(*) AS n,
            SUM(CASE WHEN ar.status = 'PENDING' AND ar.sla_due_at IS NOT NULL AND ar.sla_due_at < NOW() THEN 1 ELSE 0 END) AS overdue
     FROM access_requests ar
     LEFT JOIN employees req ON req.emp_id = ar.requester_emp_id
     LEFT JOIN employees tgt ON tgt.emp_id = ar.target_emp_id
     WHERE ${whereSql}
     GROUP BY ar.status`,
    params,
  );

  const rows = await query<{
    id: string; status: string; item_type: string; justification: string | null;
    created_at: string; decided_at: string | null; fulfilled_at: string | null;
    sla_due_at: string | null; valid_until: string | null;
    requester_emp_id: string; requester_name: string | null; requester_email: string | null;
    target_emp_id: string; target_name: string | null; target_email: string | null;
    sla_breached: number; hours_open: number;
  }>(
    `SELECT ar.id, ar.status, ar.item_type, ar.justification, ar.created_at, ar.decided_at,
            ar.fulfilled_at, ar.sla_due_at, ar.valid_until,
            ar.requester_emp_id, req.full_name AS requester_name, req.email_corp AS requester_email,
            ar.target_emp_id, tgt.full_name AS target_name, tgt.email_corp AS target_email,
            CASE
              WHEN ar.status = 'PENDING' AND ar.sla_due_at IS NOT NULL AND ar.sla_due_at < NOW() THEN 1
              ELSE 0
            END AS sla_breached,
            TIMESTAMPDIFF(HOUR, ar.created_at, COALESCE(ar.decided_at, NOW())) AS hours_open
     FROM access_requests ar
     LEFT JOIN employees req ON req.emp_id = ar.requester_emp_id
     LEFT JOIN employees tgt ON tgt.emp_id = ar.target_emp_id
     WHERE ${whereSql}
     ORDER BY ar.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  if (wantCsv(req)) {
    return sendCsv(
      res,
      'access-requests-report.csv',
      ['ID', 'Status', 'Item Type', 'Requester', 'Requester Email', 'Target', 'Target Email',
        'Created', 'Decided', 'Fulfilled', 'SLA Due', 'SLA Breached', 'Hours Open', 'Justification'],
      rows.map((r) => [
        r.id, r.status, r.item_type, r.requester_name, r.requester_email,
        r.target_name, r.target_email, r.created_at, r.decided_at, r.fulfilled_at,
        r.sla_due_at, Number(r.sla_breached) ? 'yes' : 'no', r.hours_open, r.justification,
      ]),
    );
  }

  res.json({
    data: rows,
    meta: {
      total: Number(totalRow?.n ?? 0),
      limit,
      offset,
      from,
      to,
      byStatus: summary.map((s) => ({
        status: s.status,
        n: Number(s.n),
        overdue: Number(s.overdue),
      })),
    },
  });
}));

// ---------------------------------------------------------------------------
// GET /certifications — campaign completion report
// ---------------------------------------------------------------------------
router.get('/certifications', asyncHandler(async (req: Request, res: Response) => {
  const limit = wantCsv(req) ? MAX_EXPORT : parseLimit(req.query['limit'], 100);
  const offset = wantCsv(req) ? 0 : parseOffset(req.query['offset']);
  const status = typeof req.query['status'] === 'string' ? req.query['status'].trim().toUpperCase() : '';

  const where: string[] = ['1=1'];
  const params: unknown[] = [];
  if (status) { where.push('c.status = ?'); params.push(status); }
  const whereSql = where.join(' AND ');

  const totalRow = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM access_review_campaigns c WHERE ${whereSql}`,
    params,
  );

  const rows = await query<{
    id: string; name: string; status: string; reviewer_kind: string;
    start_date: string; end_date: string; created_by: string; created_at: string;
    total_items: number; pending: number; certified: number; revoked: number; delegated: number;
  }>(
    `SELECT c.id, c.name, c.status, c.reviewer_kind, c.start_date, c.end_date, c.created_by, c.created_at,
            COUNT(i.id) AS total_items,
            SUM(CASE WHEN i.decision = 'PENDING' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN i.decision = 'CERTIFY' THEN 1 ELSE 0 END) AS certified,
            SUM(CASE WHEN i.decision = 'REVOKE' THEN 1 ELSE 0 END) AS revoked,
            SUM(CASE WHEN i.decision = 'DELEGATE' THEN 1 ELSE 0 END) AS delegated
     FROM access_review_campaigns c
     LEFT JOIN access_review_items i ON i.campaign_id = c.id
     WHERE ${whereSql}
     GROUP BY c.id, c.name, c.status, c.reviewer_kind, c.start_date, c.end_date, c.created_by, c.created_at
     ORDER BY c.start_date DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  const mapped = rows.map((r) => {
    const total = Number(r.total_items) || 0;
    const pending = Number(r.pending) || 0;
    return {
      ...r,
      total_items: total,
      pending,
      certified: Number(r.certified) || 0,
      revoked: Number(r.revoked) || 0,
      delegated: Number(r.delegated) || 0,
      completion_pct: total > 0 ? Math.round(((total - pending) / total) * 100) : 0,
    };
  });

  if (wantCsv(req)) {
    return sendCsv(
      res,
      'certifications-report.csv',
      ['ID', 'Name', 'Status', 'Reviewer Kind', 'Start', 'End', 'Total', 'Pending', 'Certified', 'Revoked', 'Delegated', 'Completion %', 'Created By'],
      mapped.map((r) => [
        r.id, r.name, r.status, r.reviewer_kind, r.start_date, r.end_date,
        r.total_items, r.pending, r.certified, r.revoked, r.delegated,
        r.completion_pct, r.created_by,
      ]),
    );
  }

  res.json({ data: mapped, meta: { total: Number(totalRow?.n ?? 0), limit, offset } });
}));

// ---------------------------------------------------------------------------
// GET /sod — segregation of duties violations
// ---------------------------------------------------------------------------
router.get('/sod', asyncHandler(async (req: Request, res: Response) => {
  const limit = wantCsv(req) ? MAX_EXPORT : parseLimit(req.query['limit']);
  const offset = wantCsv(req) ? 0 : parseOffset(req.query['offset']);
  const status = typeof req.query['status'] === 'string' ? req.query['status'].trim().toUpperCase() : '';
  const severity = typeof req.query['severity'] === 'string' ? req.query['severity'].trim().toUpperCase() : '';
  const q = typeof req.query['q'] === 'string' ? req.query['q'].trim() : '';

  const where: string[] = ['1=1'];
  const params: unknown[] = [];
  if (status) { where.push('v.status = ?'); params.push(status); }
  if (severity) { where.push('p.severity = ?'); params.push(severity); }
  if (q) {
    where.push('(e.full_name LIKE ? OR e.email_corp LIKE ? OR p.name LIKE ? OR v.emp_id LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const whereSql = where.join(' AND ');

  const totalRow = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sod_violations v
     INNER JOIN sod_policies p ON p.id = v.policy_id
     LEFT JOIN employees e ON e.emp_id = v.emp_id
     WHERE ${whereSql}`,
    params,
  );

  const rows = await query<{
    id: number; emp_id: string; full_name: string | null; email_corp: string | null;
    department: string | null; policy_id: string; policy_name: string; severity: string;
    enforcement: string; status: string; detected_at: string;
    exception_until: string | null; exception_by: string | null;
    resolved_at: string | null; notes: string | null; conflicting_ents: unknown;
  }>(
    `SELECT v.id, v.emp_id, e.full_name, e.email_corp, e.dept_id AS department,
            v.policy_id, p.name AS policy_name, p.severity, p.enforcement,
            v.status, v.detected_at, v.exception_until, v.exception_by,
            v.resolved_at, v.notes, v.conflicting_ents
     FROM sod_violations v
     INNER JOIN sod_policies p ON p.id = v.policy_id
     LEFT JOIN employees e ON e.emp_id = v.emp_id
     WHERE ${whereSql}
     ORDER BY FIELD(p.severity,'CRITICAL','HIGH','MEDIUM','LOW'), v.detected_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  if (wantCsv(req)) {
    return sendCsv(
      res,
      'sod-violations.csv',
      ['ID', 'Emp ID', 'Name', 'Email', 'Department', 'Policy', 'Severity', 'Enforcement',
        'Status', 'Detected', 'Exception Until', 'Exception By', 'Resolved', 'Notes', 'Conflicts'],
      rows.map((r) => [
        r.id, r.emp_id, r.full_name, r.email_corp, r.department,
        r.policy_name, r.severity, r.enforcement, r.status,
        r.detected_at, r.exception_until, r.exception_by, r.resolved_at, r.notes,
        typeof r.conflicting_ents === 'string' ? r.conflicting_ents : JSON.stringify(r.conflicting_ents ?? ''),
      ]),
    );
  }

  res.json({ data: rows, meta: { total: Number(totalRow?.n ?? 0), limit, offset } });
}));

// ---------------------------------------------------------------------------
// GET /app-access-changes — application access policy audit trail
// ---------------------------------------------------------------------------
router.get('/app-access-changes', asyncHandler(async (req: Request, res: Response) => {
  const limit = wantCsv(req) ? MAX_EXPORT : parseLimit(req.query['limit']);
  const offset = wantCsv(req) ? 0 : parseOffset(req.query['offset']);
  const from = parseDateBound(req.query['from'], false);
  const to = parseDateBound(req.query['to'], true);
  const action = typeof req.query['action'] === 'string' ? req.query['action'].trim().toUpperCase() : '';
  const q = typeof req.query['q'] === 'string' ? req.query['q'].trim() : '';

  const where: string[] = ['1=1'];
  const params: unknown[] = [];
  if (from) { where.push('l.created_at >= ?'); params.push(from); }
  if (to) { where.push('l.created_at <= ?'); params.push(to); }
  if (action) { where.push('l.action = ?'); params.push(action); }
  if (q) {
    where.push('(a.name LIKE ? OR a.slug LIKE ? OR l.actor_emp_id LIKE ? OR l.target_emp_id LIKE ? OR act.full_name LIKE ? OR tgt.full_name LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const whereSql = where.join(' AND ');

  const totalRow = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM app_access_audit_log l
     LEFT JOIN applications a ON a.id = l.app_id
     LEFT JOIN employees act ON act.emp_id = l.actor_emp_id
     LEFT JOIN employees tgt ON tgt.emp_id = l.target_emp_id
     WHERE ${whereSql}`,
    params,
  );

  const rows = await query<{
    id: number; action: string; created_at: string; app_id: string | null;
    app_name: string | null; app_slug: string | null;
    actor_emp_id: string | null; actor_name: string | null; actor_email: string | null;
    target_emp_id: string | null; target_name: string | null; target_email: string | null;
    tag_group_id: string | null; request_id: string | null; details: unknown;
  }>(
    `SELECT l.id, l.action, l.created_at, l.app_id, a.name AS app_name, a.slug AS app_slug,
            l.actor_emp_id, act.full_name AS actor_name, act.email_corp AS actor_email,
            l.target_emp_id, tgt.full_name AS target_name, tgt.email_corp AS target_email,
            l.tag_group_id, l.request_id, l.details
     FROM app_access_audit_log l
     LEFT JOIN applications a ON a.id = l.app_id
     LEFT JOIN employees act ON act.emp_id = l.actor_emp_id
     LEFT JOIN employees tgt ON tgt.emp_id = l.target_emp_id
     WHERE ${whereSql}
     ORDER BY l.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  if (wantCsv(req)) {
    return sendCsv(
      res,
      'app-access-changes.csv',
      ['ID', 'Action', 'App', 'App Slug', 'Actor', 'Actor Email', 'Target', 'Target Email',
        'Tag Group', 'Request ID', 'Timestamp', 'Details'],
      rows.map((r) => [
        r.id, r.action, r.app_name, r.app_slug, r.actor_name || r.actor_emp_id, r.actor_email,
        r.target_name || r.target_emp_id, r.target_email, r.tag_group_id, r.request_id,
        r.created_at,
        typeof r.details === 'string' ? r.details : JSON.stringify(r.details ?? ''),
      ]),
    );
  }

  res.json({ data: rows, meta: { total: Number(totalRow?.n ?? 0), limit, offset, from, to } });
}));

export default router;
