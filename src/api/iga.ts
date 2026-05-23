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
import { triggerConnectorSync } from '../services/connector-dispatcher.js';
import { submitAccessRequest, processDecision } from '../services/access-request-workflow.js';
import { createCampaign, submitReviewDecision } from '../services/access-review.js';
import { evaluateSodForGrant } from '../services/sod-evaluator.js';

const router = Router();

// All routes here require an authenticated session. Per-route role checks
// are applied below where stricter access is needed.
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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

const connectorSchema = z.object({
  name:          z.string().min(1).max(150),
  slug:          z.string().min(1).max(80).regex(/^[a-z0-9-]+$/),
  connectorType: z.string().min(1).max(50),
  direction:     z.enum(['INBOUND', 'OUTBOUND', 'BIDIRECTIONAL']).default('BIDIRECTIONAL'),
  syncMode:      z.enum(['FULL', 'INCREMENTAL', 'RECONCILE']).default('INCREMENTAL'),
  syncSchedule:  z.string().max(100).optional(),
  configJson:    z.record(z.unknown()).optional(),
});

router.post(
  '/connectors',
  requireRole('SUPER_ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = connectorSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
      return;
    }
    const id = uuidv4();
    try {
      await execute(
        `INSERT INTO connectors
           (id, name, slug, connector_type, direction, sync_mode, sync_schedule,
            status, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
        [
          id,
          parsed.data.name,
          parsed.data.slug,
          parsed.data.connectorType,
          parsed.data.direction,
          parsed.data.syncMode,
          parsed.data.syncSchedule ?? null,
          JSON.stringify(parsed.data.configJson ?? {}),
        ],
      );
      logger.info({ id, slug: parsed.data.slug }, 'Connector registered');
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
  asyncHandler(async (req: Request, res: Response) => {
    const connectorId = req.params['id']!;
    const triggeredBy = req.user!.empId;
    try {
      const ref = await triggerConnectorSync(connectorId, triggeredBy);
      res.json(ref);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'Connector not found') {
        res.status(404).json({ error: msg });
        return;
      }
      if (msg === 'Connector is not active') {
        res.status(409).json({ error: msg });
        return;
      }
      throw err;
    }
  }),
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

const accessRequestSchema = z.object({
  targetEmpId:   z.string().min(1).max(20),
  itemType:      z.enum(['ENTITLEMENT', 'ROLE', 'APP_ACCESS']),
  itemIds:       z.array(z.string()).min(1),
  justification: z.string().min(1).max(2000),
});

router.post(
  '/access-requests',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = accessRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
      return;
    }
    try {
      const reqId = await submitAccessRequest({
        requesterEmpId: req.user!.empId,
        targetEmpId:    parsed.data.targetEmpId,
        itemType:       parsed.data.itemType,
        itemIds:        parsed.data.itemIds,
        justification:  parsed.data.justification,
      });
      res.status(201).json({ id: reqId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found') || msg.includes('not active')) {
        res.status(404).json({ error: msg });
        return;
      }
      if (msg.includes('SoD')) {
        res.status(422).json({ error: msg, code: 'SOD_VIOLATION' });
        return;
      }
      throw err;
    }
  }),
);

const decisionSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  comment:  z.string().max(2000).optional(),
});

router.post(
  '/access-requests/:id/decision',
  asyncHandler(async (req: Request, res: Response) => {
    const requestId = req.params['id']!;
    const parsed = decisionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
      return;
    }
    try {
      await processDecision(requestId, req.user!.empId, parsed.data.decision, parsed.data.comment);
      res.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) {
        res.status(404).json({ error: msg });
        return;
      }
      if (msg.includes('not in PENDING_APPROVAL') || msg.includes('No pending approval')) {
        res.status(409).json({ error: msg });
        return;
      }
      throw err;
    }
  }),
);

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

const campaignSchema = z.object({
  name:         z.string().min(1).max(200),
  description:  z.string().max(2000).optional(),
  scope:        z.enum(['ALL_USERS', 'APP_SPECIFIC', 'ROLE_SPECIFIC', 'HIGH_RISK']),
  reviewerKind: z.enum(['MANAGER', 'APP_OWNER', 'ROLE_OWNER']),
  startDate:    z.string().min(1),
  endDate:      z.string().min(1),
  appId:        z.string().optional(),
  roleId:       z.string().optional(),
});

router.post(
  '/access-reviews',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = campaignSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
      return;
    }
    const campaignParams = {
      name:         parsed.data.name,
      scope:        parsed.data.scope,
      reviewerKind: parsed.data.reviewerKind,
      startDate:    parsed.data.startDate,
      endDate:      parsed.data.endDate,
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      ...(parsed.data.appId !== undefined ? { appId: parsed.data.appId } : {}),
      ...(parsed.data.roleId !== undefined ? { roleId: parsed.data.roleId } : {}),
    };
    const campaignId = await createCampaign(campaignParams, req.user!.empId);
    res.status(201).json({ id: campaignId });
  }),
);

// POST /access-reviews/:id/items/:itemId/decision
const reviewDecisionSchema = z.object({
  decision: z.enum(['CERTIFY', 'REVOKE', 'EXCEPTION']),
  comment:  z.string().max(2000).optional(),
});

router.post(
  '/access-reviews/:id/items/:itemId/decision',
  asyncHandler(async (req: Request, res: Response) => {
    const { itemId } = req.params as { itemId: string };
    const parsed = reviewDecisionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
      return;
    }
    try {
      await submitReviewDecision(itemId, req.user!.empId, parsed.data.decision, parsed.data.comment);
      res.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) {
        res.status(404).json({ error: msg });
        return;
      }
      if (msg.includes('does not match') || msg.includes('already decided')) {
        res.status(409).json({ error: msg });
        return;
      }
      throw err;
    }
  }),
);

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

const reportSchema = z.object({
  name:        z.string().min(1).max(200),
  framework:   z.string().min(1).max(80),
  periodStart: z.string().min(1),
  periodEnd:   z.string().min(1),
});

router.post(
  '/reports',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = reportSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
      return;
    }
    const id = uuidv4();
    await execute(
      `INSERT INTO compliance_reports
         (id, name, framework, generated_by, generated_at, period_start, period_end)
       VALUES (?, ?, ?, ?, UTC_TIMESTAMP(), ?, ?)`,
      [
        id,
        parsed.data.name,
        parsed.data.framework,
        req.user!.empId,
        parsed.data.periodStart,
        parsed.data.periodEnd,
      ],
    );
    logger.info({ id, framework: parsed.data.framework }, 'Compliance report record created');
    res.status(201).json({
      id,
      hint: 'Report record created. Attach artifact_url via PATCH once the report file is generated.',
    });
  }),
);

// ===========================================================================
// /entitlements/:entId/grant — direct grant with SoD pre-check
// ===========================================================================
const grantSchema = z.object({
  empId:     z.string().min(1).max(20),
  grantedBy: z.string().min(1).max(20).optional(),
});

router.post(
  '/entitlements/:entId/grant',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const { entId } = req.params as { entId: string };
    const parsed = grantSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
      return;
    }

    const { empId, grantedBy } = parsed.data;

    // Verify entitlement exists
    const ent = await queryOne<{ id: string }>(
      'SELECT id FROM entitlements WHERE id = ? AND active = 1',
      [entId],
    );
    if (!ent) {
      res.status(404).json({ error: 'Entitlement not found or inactive' });
      return;
    }

    // SoD pre-check
    const sodResult = await evaluateSodForGrant(empId, entId);
    const blockingViolations = sodResult.violations.filter(
      (v) => v.severity === 'CRITICAL' || v.severity === 'HIGH',
    );
    if (blockingViolations.length > 0) {
      res.status(422).json({
        error:      'SoD policy violation blocks this grant',
        code:       'SOD_VIOLATION',
        violations: blockingViolations,
      });
      return;
    }

    // Grant
    const grantId = uuidv4();
    await execute(
      `INSERT IGNORE INTO user_entitlements
         (id, emp_id, entitlement_id, source, granted_by, granted_at)
       VALUES (?, ?, ?, 'ADMIN_GRANT', ?, UTC_TIMESTAMP())`,
      [grantId, empId, entId, grantedBy ?? req.user!.empId],
    );

    logger.info({ grantId, empId, entId, grantedBy: grantedBy ?? req.user!.empId }, 'Entitlement granted directly');
    res.status(201).json({ id: grantId, empId, entitlementId: entId });
  }),
);

// ===========================================================================
// /sod-policies — CRUD for SoD policy authoring
// ===========================================================================

// POST /sod-policies — create
router.post('/sod-policies', requireRole('SUPER_ADMIN'), asyncHandler(async (req: Request, res: Response) => {
  const { name, description, severity, enforcement, conflict_groups } = req.body as {
    name: string; description?: string; severity?: string;
    enforcement?: string; conflict_groups?: unknown[];
  };
  const id = uuidv4();
  await execute(
    `INSERT INTO sod_policies (id, name, description, severity, enforcement, conflict_groups, active)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [id, name, description ?? null, severity ?? 'MEDIUM', enforcement ?? 'WARN', JSON.stringify(conflict_groups ?? [])],
  );
  res.status(201).json({ id });
}));

// PUT /sod-policies/:id
router.put('/sod-policies/:id', requireRole('SUPER_ADMIN'), asyncHandler(async (req: Request, res: Response) => {
  const { name, description, severity, enforcement, conflict_groups, active } = req.body as {
    name?: string; description?: string; severity?: string;
    enforcement?: string; conflict_groups?: unknown[]; active?: number;
  };
  await execute(
    `UPDATE sod_policies SET name=?, description=?, severity=?, enforcement=?, conflict_groups=?, active=? WHERE id=?`,
    [name, description ?? null, severity, enforcement, JSON.stringify(conflict_groups ?? []), active ? 1 : 0, req.params['id']],
  );
  res.json({ success: true });
}));

// DELETE /sod-policies/:id
router.delete('/sod-policies/:id', requireRole('SUPER_ADMIN'), asyncHandler(async (req: Request, res: Response) => {
  await execute('DELETE FROM sod_policies WHERE id = ?', [req.params['id']]);
  res.json({ success: true });
}));

export default router;
