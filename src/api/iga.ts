/**
 * IGA + Multi-protocol AM API surface.
 *
 * This is the foundation for the platform vision documented in ARCHITECTURE.md.
 * Read endpoints are wired against the new tables (003_iga_foundation.sql).
 * Write endpoints exist as scaffolds that return 501 NOT_IMPLEMENTED until
 * the corresponding service layer is built.
 *
 * Each domain (applications, connectors, entitlements, access requests,
 * reviews, SoD, risk, reports) is mounted under /api/iga/<domain>.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../auth/middleware.js';
import { requireRole } from '../auth/rbac.js';
import { execute, queryOne } from '../db/connection.js';
import { safeQuery } from '../db/safe-query.js';
import logger from '../utils/logger.js';
import { asyncHandler } from '../utils/async-handler.js';

const router = Router();

// All routes here require an authenticated session. Per-route role checks
// are applied below where stricter access is needed.
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function notImplemented(res: Response, hint?: string): void {
  res.status(501).json({
    error: 'Not implemented',
    hint:  hint ?? 'Service layer is being built; see ARCHITECTURE.md §14 Roadmap',
  });
}

function paginate(req: Request, defaultLimit = 50, maxLimit = 200): { limit: number; offset: number } {
  const limit = Math.min(parseInt((req.query['limit'] as string) ?? String(defaultLimit), 10), maxLimit);
  const offset = parseInt((req.query['offset'] as string) ?? '0', 10);
  return { limit, offset };
}

// ===========================================================================
// /applications — protocol-agnostic application catalog
// ===========================================================================
const appSchema = z.object({
  slug:        z.string().min(1).max(80).regex(/^[a-z0-9-]+$/),
  name:        z.string().min(1).max(150),
  description: z.string().max(2000).optional(),
  iconUrl:     z.string().url().optional(),
  category:    z.string().max(50).optional(),
  ownerEmpId:  z.string().max(20).optional(),
  visibility:  z.enum(['PUBLIC', 'RESTRICTED']).default('PUBLIC'),
  ssoEnabled:  z.boolean().default(true),
  provisioning: z.boolean().default(false),
});

router.get('/applications', asyncHandler(async (req: Request, res: Response) => {
  const { limit, offset } = paginate(req);
  const rows = await safeQuery<Record<string, unknown>>(
    `SELECT a.id, a.slug, a.name, a.description, a.icon_url, a.category,
            a.owner_emp_id, a.visibility, a.sso_enabled, a.provisioning,
            a.risk_score, a.active, a.created_at, a.updated_at,
            (SELECT COUNT(*) FROM app_protocol_configs c WHERE c.app_id = a.id AND c.active = 1) AS protocol_count
       FROM applications a
      ORDER BY a.sort_order ASC, a.name ASC
      LIMIT ? OFFSET ?`,
    [limit, offset],
  );
  res.json({ data: rows, total: rows.length, limit, offset });
}));

router.post(
  '/applications',
  requireRole('SUPER_ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = appSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
      return;
    }
    const id = uuidv4();
    try {
      await execute(
        `INSERT INTO applications
           (id, slug, name, description, icon_url, category, owner_emp_id,
            visibility, sso_enabled, provisioning)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          parsed.data.slug,
          parsed.data.name,
          parsed.data.description ?? null,
          parsed.data.iconUrl ?? null,
          parsed.data.category ?? null,
          parsed.data.ownerEmpId ?? null,
          parsed.data.visibility,
          parsed.data.ssoEnabled ? 1 : 0,
          parsed.data.provisioning ? 1 : 0,
        ],
      );
      logger.info({ id, slug: parsed.data.slug }, 'Application registered');
      res.status(201).json({ id, slug: parsed.data.slug });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Insert failed';
      if (msg.includes('Duplicate')) {
        res.status(409).json({ error: 'Slug already in use' });
        return;
      }
      res.status(400).json({ error: msg });
    }
  }),
);

router.get('/applications/:id', asyncHandler(async (req: Request, res: Response) => {
  const app = await queryOne<Record<string, unknown>>(
    `SELECT * FROM applications WHERE id = ? OR slug = ?`,
    [req.params['id'], req.params['id']],
  );
  if (!app) {
    res.status(404).json({ error: 'Application not found' });
    return;
  }
  const protocols = await safeQuery<Record<string, unknown>>(
    `SELECT id, protocol, active, created_at FROM app_protocol_configs WHERE app_id = ?`,
    [app['id']],
  );
  res.json({ ...app, protocols });
}));

// ===========================================================================
// /connectors — pluggable target system adapters
// ===========================================================================
router.get(
  '/connectors',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const { limit, offset } = paginate(req);
    const rows = await safeQuery<Record<string, unknown>>(
      `SELECT id, name, slug, connector_type, direction, sync_mode, sync_schedule,
              status, last_sync_at, last_error, created_at, updated_at
         FROM connectors
        ORDER BY name ASC
        LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    res.json({ data: rows, total: rows.length, limit, offset });
  }),
);

router.post('/connectors', requireRole('SUPER_ADMIN'), (_req, res) => {
  notImplemented(res, 'Connector registration runs validation against the target system; service layer pending');
});

router.get(
  '/connectors/:id/runs',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const { limit, offset } = paginate(req);
    const rows = await safeQuery<Record<string, unknown>>(
      `SELECT id, run_type, status, started_at, ended_at,
              items_processed, items_succeeded, items_failed, error_summary
         FROM connector_runs
        WHERE connector_id = ?
        ORDER BY started_at DESC
        LIMIT ? OFFSET ?`,
      [req.params['id'], limit, offset],
    );
    res.json({ data: rows, limit, offset });
  }),
);

router.post(
  '/connectors/:id/sync',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  (_req, res) => notImplemented(res, 'Connector dispatcher pending — will enqueue an adapter_outbox job'),
);

// ===========================================================================
// /entitlements — granular permissions
// ===========================================================================
router.get(
  '/entitlements',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const { limit, offset } = paginate(req);
    const appId = req.query['appId'] as string | undefined;
    const where: string[] = [];
    const params: unknown[] = [];
    if (appId) { where.push('e.app_id = ?'); params.push(appId); }
    const rows = await safeQuery<Record<string, unknown>>(
      `SELECT e.id, e.app_id, e.connector_id, e.name, e.slug, e.type,
              e.risk_score, e.is_birthright, e.requires_review, e.active, e.created_at,
              a.name AS app_name
         FROM entitlements e
         LEFT JOIN applications a ON a.id = e.app_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY e.name ASC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    res.json({ data: rows, limit, offset });
  }),
);

router.get('/entitlements/me', asyncHandler(async (req: Request, res: Response) => {
  const empId = req.user!.empId;
  const rows = await safeQuery<Record<string, unknown>>(
    `SELECT ue.id, ue.entitlement_id, ue.source, ue.granted_at, ue.expires_at, ue.last_used_at,
            e.name AS entitlement_name, e.type, e.risk_score,
            a.name AS app_name, a.slug AS app_slug, a.icon_url
       FROM user_entitlements ue
       JOIN entitlements e ON e.id = ue.entitlement_id
       LEFT JOIN applications a ON a.id = e.app_id
      WHERE ue.emp_id = ? AND ue.revoked_at IS NULL
      ORDER BY ue.granted_at DESC`,
    [empId],
  );
  res.json({ data: rows });
}));

// ===========================================================================
// /access-requests — request workflow
// ===========================================================================
router.get('/access-requests', asyncHandler(async (req: Request, res: Response) => {
  const empId = req.user!.empId;
  const scope = (req.query['scope'] as string) ?? 'mine';
  const { limit, offset } = paginate(req);

  let where = '';
  const params: unknown[] = [];

  if (scope === 'mine') {
    where = 'WHERE ar.requester_emp_id = ?';
    params.push(empId);
  } else if (scope === 'tasks') {
    where = `WHERE EXISTS (
      SELECT 1 FROM access_request_approvals a
       WHERE a.request_id = ar.id
         AND a.approver_emp_id = ?
         AND a.decision = 'PENDING'
    )`;
    params.push(empId);
  } else if (scope === 'all') {
    if (!['ADMIN', 'SUPER_ADMIN'].includes(req.user!.role)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
  }

  const rows = await safeQuery<Record<string, unknown>>(
    `SELECT ar.id, ar.requester_emp_id, ar.target_emp_id, ar.item_type,
            ar.item_ids, ar.justification, ar.status, ar.created_at,
            ar.decided_at, ar.fulfilled_at, ar.sla_due_at,
            r.full_name AS requester_name, t.full_name AS target_name
       FROM access_requests ar
       LEFT JOIN employees r ON r.emp_id = ar.requester_emp_id
       LEFT JOIN employees t ON t.emp_id = ar.target_emp_id
       ${where}
       ORDER BY ar.created_at DESC
       LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  res.json({ data: rows, limit, offset });
}));

router.post('/access-requests', (_req, res) => {
  notImplemented(res, 'Approval-chain resolver and SoD pre-check pending');
});

router.post('/access-requests/:id/decision', (_req, res) => {
  notImplemented(res, 'Approval decision handler pending');
});

// ===========================================================================
// /access-reviews — certification campaigns
// ===========================================================================
router.get(
  '/access-reviews',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const { limit, offset } = paginate(req);
    const rows = await safeQuery<Record<string, unknown>>(
      `SELECT id, name, description, scope, reviewer_kind, start_date, end_date,
              status, created_by, created_at,
              (SELECT COUNT(*) FROM access_review_items i WHERE i.campaign_id = c.id) AS item_count,
              (SELECT COUNT(*) FROM access_review_items i WHERE i.campaign_id = c.id AND i.decision = 'PENDING') AS pending_count
         FROM access_review_campaigns c
        ORDER BY start_date DESC
        LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    res.json({ data: rows, limit, offset });
  }),
);

router.get('/access-reviews/me', asyncHandler(async (req: Request, res: Response) => {
  const empId = req.user!.empId;
  const rows = await safeQuery<Record<string, unknown>>(
    `SELECT i.id, i.campaign_id, c.name AS campaign_name, c.end_date,
            i.emp_id, e.full_name AS subject_name,
            i.entitlement_id, ent.name AS entitlement_name,
            i.role_id, br.name AS role_name,
            i.decision, i.decided_at
       FROM access_review_items i
       JOIN access_review_campaigns c ON c.id = i.campaign_id
       LEFT JOIN employees e   ON e.emp_id = i.emp_id
       LEFT JOIN entitlements ent ON ent.id = i.entitlement_id
       LEFT JOIN business_roles br ON br.id = i.role_id
      WHERE i.reviewer_emp_id = ? AND i.decision = 'PENDING'
        AND c.status = 'ACTIVE'
      ORDER BY c.end_date ASC`,
    [empId],
  );
  res.json({ data: rows });
}));

router.post('/access-reviews', requireRole('ADMIN', 'SUPER_ADMIN'), (_req, res) => {
  notImplemented(res, 'Campaign generator pending');
});

// ===========================================================================
// /sod-policies — Segregation of Duties
// ===========================================================================
router.get(
  '/sod-policies',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (_req: Request, res: Response) => {
    const rows = await safeQuery<Record<string, unknown>>(
      `SELECT id, name, description, severity, enforcement, conflict_groups, active, created_at
         FROM sod_policies
        ORDER BY severity DESC, name ASC`,
      [],
    );
    res.json({ data: rows });
  }),
);

router.get(
  '/sod-violations',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const status = (req.query['status'] as string) ?? 'OPEN';
    const rows = await safeQuery<Record<string, unknown>>(
      `SELECT v.id, v.policy_id, p.name AS policy_name, p.severity,
              v.emp_id, e.full_name AS emp_name, e.email_corp,
              v.conflicting_ents, v.detected_at, v.status, v.exception_until
         FROM sod_violations v
         JOIN sod_policies p ON p.id = v.policy_id
         LEFT JOIN employees e ON e.emp_id = v.emp_id
        WHERE v.status = ?
        ORDER BY p.severity DESC, v.detected_at DESC`,
      [status],
    );
    res.json({ data: rows });
  }),
);

// ===========================================================================
// /risk — risk scoring
// ===========================================================================
router.get(
  '/risk/dashboard',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (_req: Request, res: Response) => {
    const [topRisk, denied24h, mfa24h] = await Promise.all([
      safeQuery<Record<string, unknown>>(
        `SELECT r.emp_id, e.full_name, e.email_corp, r.score, r.factors, r.updated_at
           FROM risk_scores r
           JOIN employees e ON e.emp_id = r.emp_id
          WHERE r.score >= 50
          ORDER BY r.score DESC
          LIMIT 25`,
        [],
      ),
      queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM login_risk_events
          WHERE decision IN ('DENY','BLOCK')
            AND ts > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)`,
        [],
      ).catch(() => ({ n: 0 })),
      queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM login_risk_events
          WHERE decision = 'MFA'
            AND ts > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)`,
        [],
      ).catch(() => ({ n: 0 })),
    ]);
    res.json({
      topRisk,
      counters: {
        deniedLast24h:    denied24h?.n ?? 0,
        mfaChallengeLast24h: mfa24h?.n ?? 0,
      },
    });
  }),
);

// ===========================================================================
// /reports — compliance reports
// ===========================================================================
router.get(
  '/reports',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (_req: Request, res: Response) => {
    const rows = await safeQuery<Record<string, unknown>>(
      `SELECT id, name, framework, generated_by, generated_at, period_start, period_end, artifact_url
         FROM compliance_reports
        ORDER BY generated_at DESC
        LIMIT 100`,
      [],
    );
    res.json({ data: rows });
  }),
);

router.post('/reports', requireRole('ADMIN', 'SUPER_ADMIN'), (_req, res) => {
  notImplemented(res, 'Report generator pending');
});

export default router;
