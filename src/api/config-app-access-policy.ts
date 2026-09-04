/**
 * Config — Application Access Policy API
 * Mounted at /api/admin/app-access-policy
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../auth/middleware.js';
import { requireRole, requirePortalModule } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import { query, queryOne, execute } from '../db/connection.js';
import logger from '../utils/logger.js';
import {
  grantAppAccess,
  updateAppAccess,
  revokeAppAccess,
  parseApprovalLevels,
  parseRequesterGroupIds,
  listAssignableApplications,
  setApplicationRequestable,
  setApplicationAllowedCidrs,
  syncSamlAppsToCatalog,
  type ApprovalLevel,
} from '../services/app-access-policy.js';
import { syncOidcAppsToCatalog } from '../oidc/portal-apps.js';
import { parseCidrList } from '../utils/ip-match.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('ADMIN', 'SUPER_ADMIN'), requirePortalModule('access_model'));

function actorEmpId(req: Request): string | null {
  return (req as unknown as { user?: { empId?: string } }).user?.empId ?? null;
}

const approvalLevelSchema = z.object({
  level:         z.number().int().min(1),
  approverType:  z.enum(['MANAGER', 'APP_OWNER', 'ADMIN', 'SPECIFIC']),
  approverEmpId: z.string().max(20).optional(),
});

// GET /summary — dashboard counts for the admin page
router.get('/summary', asyncHandler(async (_req: Request, res: Response) => {
  const [assignments, tagGroups, workflows, auditRecent] = await Promise.all([
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM app_access_assignments WHERE active = 1`, [],
    ),
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM tag_groups WHERE active = 1`, [],
    ),
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM app_group_access_workflows WHERE active = 1`, [],
    ),
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM app_access_audit_log
        WHERE created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)`, [],
    ),
  ]);
  res.json({
    activeAssignments: assignments?.n ?? 0,
    activeTagGroups:   tagGroups?.n ?? 0,
    activeWorkflows:   workflows?.n ?? 0,
    auditEvents30d:    auditRecent?.n ?? 0,
  });
}));

// GET /applications — assignable apps (IGA catalog + mirrored SAML SPs)
router.get('/applications', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await listAssignableApplications();
  res.json({ data: rows });
}));

// POST /sync-catalog — repair SAML/OIDC → applications links (idempotent)
router.post('/sync-catalog', asyncHandler(async (_req: Request, res: Response) => {
  let oidcSynced = 0;
  try {
    oidcSynced = await syncOidcAppsToCatalog();
  } catch (err) {
    logger.warn({ err }, 'OIDC catalog sync failed');
  }
  const samlSynced = await syncSamlAppsToCatalog();
  const rows = await listAssignableApplications();
  res.json({ samlSynced, oidcSynced, assignable: rows.length, data: rows });
}));

// ===========================================================================
// Tag groups
// ===========================================================================
router.get('/tag-groups', asyncHandler(async (req: Request, res: Response) => {
  const activeOnly = (req.query['activeOnly'] as string) !== '0';
  const rows = await query(
    `SELECT tg.id, tg.name, tg.description, tg.tags, tg.active, tg.created_at,
       (SELECT COUNT(*) FROM tag_group_members m WHERE m.tag_group_id = tg.id) AS member_count
     FROM tag_groups tg
     ${activeOnly ? 'WHERE tg.active = 1' : ''}
     ORDER BY tg.name`,
    [],
  );
  res.json({ data: rows });
}));

const tagGroupSchema = z.object({
  name:        z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  tags:        z.array(z.string().min(1).max(80)).min(1),
});

router.post('/tag-groups', asyncHandler(async (req: Request, res: Response) => {
  const parsed = tagGroupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }
  const id = uuidv4();
  await execute(
    `INSERT INTO tag_groups (id, name, description, tags, created_by)
     VALUES (?, ?, ?, ?, ?)`,
    [id, parsed.data.name, parsed.data.description ?? null, JSON.stringify(parsed.data.tags), actorEmpId(req)],
  );
  res.status(201).json({ id });
}));

router.get('/tag-groups/:id', asyncHandler(async (req: Request, res: Response) => {
  const group = await queryOne<Record<string, unknown>>(
    `SELECT * FROM tag_groups WHERE id = ?`, [req.params['id']],
  );
  if (!group) { res.status(404).json({ error: 'Not found' }); return; }
  const members = await query(
    `SELECT m.emp_id, e.full_name, e.email_corp, m.added_at
       FROM tag_group_members m
       JOIN employees e ON e.emp_id = m.emp_id
      WHERE m.tag_group_id = ?
      ORDER BY e.full_name`,
    [req.params['id']],
  );
  res.json({ ...group, members });
}));

router.put('/tag-groups/:id', asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as { name?: string; description?: string; tags?: string[]; active?: number };
  await execute(
    `UPDATE tag_groups SET
       name = COALESCE(?, name),
       description = COALESCE(?, description),
       tags = COALESCE(?, tags),
       active = COALESCE(?, active),
       updated_at = UTC_TIMESTAMP()
     WHERE id = ?`,
    [
      body.name ?? null,
      body.description ?? null,
      body.tags ? JSON.stringify(body.tags) : null,
      body.active ?? null,
      req.params['id'],
    ],
  );
  res.json({ success: true });
}));

router.delete('/tag-groups/:id', asyncHandler(async (req: Request, res: Response) => {
  await execute(
    `UPDATE tag_groups SET active = 0, updated_at = UTC_TIMESTAMP() WHERE id = ?`,
    [req.params['id']],
  );
  res.json({ success: true });
}));

router.post('/tag-groups/:id/members', asyncHandler(async (req: Request, res: Response) => {
  const { empId } = req.body as { empId: string };
  if (!empId) { res.status(400).json({ error: 'empId required' }); return; }
  await execute(
    `INSERT IGNORE INTO tag_group_members (tag_group_id, emp_id, added_by) VALUES (?, ?, ?)`,
    [req.params['id'], empId, actorEmpId(req)],
  );
  res.status(201).json({ success: true });
}));

router.delete('/tag-groups/:id/members/:empId', asyncHandler(async (req: Request, res: Response) => {
  await execute(
    `DELETE FROM tag_group_members WHERE tag_group_id = ? AND emp_id = ?`,
    [req.params['id'], req.params['empId']],
  );
  res.json({ success: true });
}));

// ===========================================================================
// Application assignments
// ===========================================================================
router.get('/assignments', asyncHandler(async (req: Request, res: Response) => {
  const appId = (req.query['appId'] as string) || null;
  const params: unknown[] = [];
  let where = 'WHERE aaa.active = 1';
  if (appId) {
    where += ' AND aaa.app_id = ?';
    params.push(appId);
  }
  let rows: Record<string, unknown>[] = [];
  try {
    rows = await query<Record<string, unknown>>(
      `SELECT aaa.id, aaa.app_id, aaa.assignment_type, aaa.target_id,
              aaa.granted_by, aaa.granted_at,
              COALESCE(a.name, '[missing application]') AS app_name, a.slug AS app_slug,
              CASE aaa.assignment_type
                WHEN 'USER' THEN e.full_name
                WHEN 'TAG_GROUP' THEN tg.name
                WHEN 'GROUP' THEN g.name
              END AS target_name
         FROM app_access_assignments aaa
         LEFT JOIN applications a ON a.id = aaa.app_id
         LEFT JOIN employees e
           ON e.emp_id COLLATE utf8mb4_unicode_ci = aaa.target_id COLLATE utf8mb4_unicode_ci
          AND aaa.assignment_type = 'USER'
         LEFT JOIN tag_groups tg
           ON tg.id COLLATE utf8mb4_unicode_ci = aaa.target_id COLLATE utf8mb4_unicode_ci
          AND aaa.assignment_type = 'TAG_GROUP'
         LEFT JOIN \`groups\` g
           ON g.id COLLATE utf8mb4_unicode_ci = aaa.target_id COLLATE utf8mb4_unicode_ci
          AND aaa.assignment_type = 'GROUP'
         ${where}
         ORDER BY aaa.granted_at DESC`,
      params,
    );
  } catch (err) {
    logger.warn({ err }, 'GET /assignments enriched query failed; trying fallback');
    rows = await query<Record<string, unknown>>(
      `SELECT aaa.id, aaa.app_id, aaa.assignment_type, aaa.target_id,
              aaa.granted_by, aaa.granted_at,
              COALESCE(a.name, '[missing application]') AS app_name, a.slug AS app_slug,
              aaa.target_id AS target_name
         FROM app_access_assignments aaa
         LEFT JOIN applications a ON a.id = aaa.app_id
         ${where}
         ORDER BY aaa.granted_at DESC`,
      params,
    ).catch((fallbackErr) => {
      logger.error({ err: fallbackErr }, 'GET /assignments fallback query failed');
      return [];
    });
  }
  res.json({ data: rows });
}));

const assignmentSchema = z.object({
  appId:          z.string().min(1).max(36),
  assignmentType: z.enum(['USER', 'TAG_GROUP', 'GROUP']),
  /** emp_id / employee_number / email for USER; group UUID otherwise */
  targetId:       z.string().min(1).max(255),
});

function mapAssignmentError(res: Response, err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (
    msg.includes('not found')
    || msg.includes('not active')
    || msg.includes('inactive')
    || msg.includes('required')
    || msg.includes('too long')
  ) {
    const status = msg.includes('not found') && !msg.includes('Employee') ? 404 : 400;
    res.status(status).json({ error: msg });
    return true;
  }
  if (msg.includes('already exists')) {
    res.status(409).json({ error: msg });
    return true;
  }
  return false;
}

router.post('/assignments', asyncHandler(async (req: Request, res: Response) => {
  const parsed = assignmentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }
  const grantedBy = actorEmpId(req);
  if (!grantedBy) { res.status(401).json({ error: 'Unauthorized' }); return; }

  try {
    const id = await grantAppAccess({
      appId:          parsed.data.appId,
      assignmentType: parsed.data.assignmentType,
      targetId:       parsed.data.targetId,
      grantedBy,
      source:         'ADMIN',
    });
    res.status(201).json({ id });
  } catch (err) {
    if (mapAssignmentError(res, err)) return;
    throw err;
  }
}));

router.put('/assignments/:id', asyncHandler(async (req: Request, res: Response) => {
  const parsed = assignmentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }
  const updatedBy = actorEmpId(req);
  if (!updatedBy) { res.status(401).json({ error: 'Unauthorized' }); return; }

  try {
    await updateAppAccess(req.params['id']!, {
      appId:          parsed.data.appId,
      assignmentType: parsed.data.assignmentType,
      targetId:       parsed.data.targetId,
      updatedBy,
    });
    res.json({ success: true });
  } catch (err) {
    if (mapAssignmentError(res, err)) return;
    throw err;
  }
}));

// PUT /applications/:id/ip-policy — per-app IP/CIDR allowlist for SSO launch
const ipPolicySchema = z.object({
  allowedCidrs: z.array(z.string().min(1).max(64)).max(64),
});

router.put('/applications/:id/ip-policy', asyncHandler(async (req: Request, res: Response) => {
  const parsed = ipPolicySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }
  try {
    const cidrs = parseCidrList(parsed.data.allowedCidrs);
    await setApplicationAllowedCidrs(req.params['id']!, cidrs);
    res.json({ success: true, allowedCidrs: cidrs });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found')) {
      res.status(404).json({ error: msg });
      return;
    }
    throw err;
  }
}));

router.delete('/assignments/:id', asyncHandler(async (req: Request, res: Response) => {
  const revokedBy = actorEmpId(req);
  if (!revokedBy) { res.status(401).json({ error: 'Unauthorized' }); return; }
  try {
    await revokeAppAccess(req.params['id']!, revokedBy);
    res.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found')) {
      res.status(404).json({ error: msg });
      return;
    }
    throw err;
  }
}));

// ===========================================================================
// Group access workflows
// ===========================================================================
router.get('/workflows', asyncHandler(async (req: Request, res: Response) => {
  const appId = (req.query['appId'] as string) || null;
  const params: unknown[] = [];
  let where = 'WHERE w.active = 1';
  if (appId) {
    where += ' AND w.app_id = ?';
    params.push(appId);
  }
  const rows = await query<Record<string, unknown>>(
    `SELECT w.id, w.app_id, w.tag_group_id, w.name, w.approval_levels,
            w.requester_group_ids, w.auto_provision, w.active, w.created_at,
            a.name AS app_name, a.requestable AS app_requestable,
            tg.name AS tag_group_name
       FROM app_group_access_workflows w
       JOIN applications a ON a.id = w.app_id
       LEFT JOIN tag_groups tg ON tg.id = w.tag_group_id
       ${where}
       ORDER BY a.name, w.name`,
    params,
  );
  res.json({
    data: rows.map((r) => ({
      ...r,
      requester_group_ids: parseRequesterGroupIds(r['requester_group_ids']),
    })),
  });
}));

const workflowSchema = z.object({
  appId:             z.string().uuid(),
  tagGroupId:        z.string().uuid().nullable().optional(),
  name:              z.string().min(1).max(150),
  approvalLevels:    z.array(approvalLevelSchema).min(1),
  autoProvision:     z.boolean().optional(),
  /** Show this application in end-user Request Access (JIT). */
  requestable:       z.boolean().optional(),
  /** Identity group IDs allowed to submit requests; empty = any authenticated user. */
  requesterGroupIds: z.array(z.string().uuid()).optional(),
});

router.post('/workflows', asyncHandler(async (req: Request, res: Response) => {
  const parsed = workflowSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }
  const id = uuidv4();
  const requesterGroupIds = parsed.data.requesterGroupIds ?? [];
  await execute(
    `INSERT INTO app_group_access_workflows
       (id, app_id, tag_group_id, name, approval_levels, requester_group_ids, auto_provision, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      parsed.data.appId,
      parsed.data.tagGroupId ?? null,
      parsed.data.name,
      JSON.stringify(parsed.data.approvalLevels),
      JSON.stringify(requesterGroupIds),
      parsed.data.autoProvision !== false ? 1 : 0,
      actorEmpId(req),
    ],
  );
  if (parsed.data.requestable !== undefined) {
    await setApplicationRequestable(parsed.data.appId, parsed.data.requestable);
  } else {
    // Creating a request workflow implies JIT unless explicitly opted out.
    await setApplicationRequestable(parsed.data.appId, true);
  }
  res.status(201).json({ id });
}));

router.put('/workflows/:id', asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as {
    name?: string;
    approvalLevels?: ApprovalLevel[];
    autoProvision?: boolean;
    active?: number;
    tagGroupId?: string | null;
    requesterGroupIds?: string[];
    requestable?: boolean;
  };
  const levelsJson = body.approvalLevels ? JSON.stringify(body.approvalLevels) : null;
  const requesterJson = body.requesterGroupIds !== undefined
    ? JSON.stringify(body.requesterGroupIds)
    : null;

  const existing = await queryOne<{ app_id: string }>(
    `SELECT app_id FROM app_group_access_workflows WHERE id = ?`,
    [req.params['id']],
  );
  if (!existing) {
    res.status(404).json({ error: 'Workflow not found' });
    return;
  }

  await execute(
    `UPDATE app_group_access_workflows SET
       name = COALESCE(?, name),
       tag_group_id = COALESCE(?, tag_group_id),
       approval_levels = COALESCE(?, approval_levels),
       requester_group_ids = COALESCE(?, requester_group_ids),
       auto_provision = COALESCE(?, auto_provision),
       active = COALESCE(?, active),
       updated_at = UTC_TIMESTAMP()
     WHERE id = ?`,
    [
      body.name ?? null,
      body.tagGroupId !== undefined ? body.tagGroupId : null,
      levelsJson,
      requesterJson,
      body.autoProvision !== undefined ? (body.autoProvision ? 1 : 0) : null,
      body.active ?? null,
      req.params['id'],
    ],
  );
  if (body.requestable !== undefined) {
    await setApplicationRequestable(existing.app_id, body.requestable);
  }
  res.json({ success: true });
}));

router.delete('/workflows/:id', asyncHandler(async (req: Request, res: Response) => {
  await execute(
    `UPDATE app_group_access_workflows SET active = 0, updated_at = UTC_TIMESTAMP() WHERE id = ?`,
    [req.params['id']],
  );
  res.json({ success: true });
}));

// GET /workflows/:id — detail with parsed levels
router.get('/workflows/:id', asyncHandler(async (req: Request, res: Response) => {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT w.*, a.name AS app_name, tg.name AS tag_group_name
       FROM app_group_access_workflows w
       JOIN applications a ON a.id = w.app_id
       LEFT JOIN tag_groups tg ON tg.id = w.tag_group_id
      WHERE w.id = ?`,
    [req.params['id']],
  );
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({
    ...row,
    approval_levels_parsed: parseApprovalLevels(row['approval_levels']),
  });
}));

// ===========================================================================
// Audit log
// ===========================================================================
router.get('/audit', asyncHandler(async (req: Request, res: Response) => {
  const appId = (req.query['appId'] as string) || null;
  const limit = Math.min(parseInt(String(req.query['limit'] ?? '100'), 10) || 100, 500);
  const params: unknown[] = [];
  let where = '';
  if (appId) {
    where = 'WHERE l.app_id = ?';
    params.push(appId);
  }
  const rows = await query(
    `SELECT l.id, l.app_id, l.action, l.actor_emp_id, l.target_emp_id,
            l.tag_group_id, l.request_id, l.details, l.created_at,
            a.name AS app_name,
            ae.full_name AS actor_name,
            te.full_name AS target_name,
            tg.name AS tag_group_name
       FROM app_access_audit_log l
       LEFT JOIN applications a ON a.id = l.app_id
       LEFT JOIN employees ae ON ae.emp_id = l.actor_emp_id
       LEFT JOIN employees te ON te.emp_id = l.target_emp_id
       LEFT JOIN tag_groups tg ON tg.id = l.tag_group_id
       ${where}
       ORDER BY l.created_at DESC
       LIMIT ?`,
    [...params, limit],
  );
  res.json({ data: rows });
}));

export default router;
