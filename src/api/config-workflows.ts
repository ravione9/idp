/**
 * Config — Workflows + Event Triggers API
 * Mounted at /api/admin/workflows
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../auth/middleware.js';
import { requireRole } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import { query, execute } from '../db/connection.js';
import { parseWorkflowSteps } from '../services/workflow-engine.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('ADMIN', 'SUPER_ADMIN'));

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const workflowStepSchema = z.object({
  type: z.enum(['NOTIFY', 'GRANT_BIRTHRIGHT', 'REVOKE_BIRTHRIGHT', 'WEBHOOK']),
  name: z.string().max(100).optional(),
  config: z.record(z.unknown()).optional(),
});

const workflowDefSchema = z.object({
  name:        z.string().min(1).max(150),
  description: z.string().max(2000).optional(),
  trigger_event: z.enum([
    'JOINER', 'LEAVER', 'MOVER', 'SUSPEND', 'UNSUSPEND',
    'MFA_ENROLLED', 'SUSPICIOUS_LOGIN', 'ROLE_CHANGE', 'ACCESS_REQUEST',
  ]).optional(),
  steps:       z.array(workflowStepSchema).optional(),
  steps_json:  z.array(workflowStepSchema).optional(),
  active:      z.number().int().min(0).max(1).optional(),
});

const eventTriggerSchema = z.object({
  name:         z.string().min(1).max(150),
  description:  z.string().max(2000).optional(),
  event_type:   z.enum([
    'JOINER', 'LEAVER', 'MOVER', 'SUSPEND', 'UNSUSPEND',
    'MFA_ENROLLED', 'SUSPICIOUS_LOGIN', 'ROLE_CHANGE', 'ACCESS_REQUEST',
  ]),
  filter_json:  z.record(z.unknown()).optional(),
  // API-native fields
  action_type:    z.enum(['WEBHOOK', 'SLACK', 'EMAIL', 'WORKFLOW']).optional(),
  action_config:  z.record(z.unknown()).optional(),
  // UI-friendly aliases (mapped to action_type / action_config)
  channel:      z.enum(['WEBHOOK', 'SLACK', 'TEAMS', 'EMAIL', 'WORKFLOW']).optional(),
  target_url:   z.string().url().optional(),
  secret:       z.string().max(500).optional(),
  active:       z.number().int().min(0).max(1).optional(),
});

// ---------------------------------------------------------------------------
// Response normalizers (frontend expects steps, channel, target_url)
// ---------------------------------------------------------------------------
function normalizeWorkflowRow(row: Record<string, unknown>): Record<string, unknown> {
  const steps = parseWorkflowSteps(row['steps_json'] as string | null);
  return {
    ...row,
    steps,
    steps_count: steps.length,
  };
}

function normalizeTriggerRow(row: Record<string, unknown>): Record<string, unknown> {
  let config: Record<string, unknown> = {};
  const raw = row['action_config'];
  if (typeof raw === 'string') {
    try { config = JSON.parse(raw) as Record<string, unknown>; } catch { /* ignore */ }
  } else if (raw && typeof raw === 'object') {
    config = raw as Record<string, unknown>;
  }
  const actionType = row['action_type'] as string;
  const secret = (config['secret'] as string) ?? null;
  // Never echo webhook secrets back to the browser.
  const { action_config: _rawCfg, ...rest } = row;
  return {
    ...rest,
    channel: actionType,
    target_url: (config['url'] as string) ?? (config['target_url'] as string) ?? null,
    target: (config['url'] as string) ?? (config['target_url'] as string) ?? null,
    has_secret: Boolean(secret),
    secret: null,
  };
}

function resolveTriggerAction(body: z.infer<typeof eventTriggerSchema>): {
  action_type: 'WEBHOOK' | 'SLACK' | 'EMAIL' | 'WORKFLOW';
  action_config: Record<string, unknown>;
} {
  if (body.action_type && body.action_config) {
    return { action_type: body.action_type, action_config: body.action_config };
  }

  const channel = body.channel ?? 'WEBHOOK';
  const action_type = channel === 'TEAMS' ? 'WEBHOOK' : channel;
  const action_config: Record<string, unknown> = body.action_config ?? {};
  if (body.target_url) action_config['url'] = body.target_url;
  if (body.secret) action_config['secret'] = body.secret;
  if (channel === 'TEAMS') action_config['teams'] = true;

  return { action_type, action_config };
}

function resolveSteps(body: z.infer<typeof workflowDefSchema>): unknown[] | null {
  const steps = body.steps ?? body.steps_json;
  return steps && steps.length > 0 ? steps : null;
}

// ── Workflow Definitions ───────────────────────────────────────────────────

router.get('/definitions', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM workflow_definitions ORDER BY name`,
    [],
  );
  res.json({ data: rows.map(normalizeWorkflowRow) });
}));

router.post('/definitions', asyncHandler(async (req: Request, res: Response) => {
  const parsed = workflowDefSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }
  const steps = resolveSteps(parsed.data);
  const id = uuidv4();
  const empId = (req as unknown as { user?: { empId?: string } }).user?.empId ?? null;
  await execute(
    `INSERT INTO workflow_definitions
       (id, name, description, trigger_event, steps_json, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      parsed.data.name,
      parsed.data.description ?? null,
      parsed.data.trigger_event ?? null,
      steps ? JSON.stringify(steps) : null,
      empId,
    ],
  );
  res.status(201).json({ id });
}));

router.put('/definitions/:id', asyncHandler(async (req: Request, res: Response) => {
  const parsed = workflowDefSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }
  const steps = resolveSteps(parsed.data as z.infer<typeof workflowDefSchema>);
  await execute(
    `UPDATE workflow_definitions SET
       name = COALESCE(?, name),
       description = COALESCE(?, description),
       trigger_event = COALESCE(?, trigger_event),
       steps_json = COALESCE(?, steps_json),
       active = COALESCE(?, active),
       updated_at = UTC_TIMESTAMP()
     WHERE id = ?`,
    [
      parsed.data.name ?? null,
      parsed.data.description ?? null,
      parsed.data.trigger_event ?? null,
      steps ? JSON.stringify(steps) : null,
      parsed.data.active ?? null,
      req.params['id'],
    ],
  );
  res.json({ success: true });
}));

router.delete('/definitions/:id', asyncHandler(async (req: Request, res: Response) => {
  await execute(
    `UPDATE workflow_definitions SET active=0, updated_at=UTC_TIMESTAMP() WHERE id=?`,
    [req.params['id']],
  );
  res.json({ success: true });
}));

// ── Workflow Runs (execution history) ─────────────────────────────────────

router.get('/runs', asyncHandler(async (req: Request, res: Response) => {
  const limit = Math.min(parseInt((req.query['limit'] as string) ?? '50', 10), 200);
  const rows = await query(
    `SELECT r.*, w.name AS workflow_name, e.full_name AS emp_name
       FROM workflow_runs r
       JOIN workflow_definitions w ON w.id = r.workflow_id
       JOIN employees e ON e.emp_id = r.emp_id
      ORDER BY r.started_at DESC
      LIMIT ?`,
    [limit],
  );
  res.json({ data: rows });
}));

// ── Event Triggers ────────────────────────────────────────────────────────

router.get('/triggers', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM event_triggers ORDER BY event_type, name`,
    [],
  );
  res.json({ data: rows.map(normalizeTriggerRow) });
}));

router.post('/triggers', asyncHandler(async (req: Request, res: Response) => {
  const parsed = eventTriggerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }
  const { action_type, action_config } = resolveTriggerAction(parsed.data);
  if (action_type !== 'EMAIL' && !action_config['url'] && action_type !== 'WORKFLOW') {
    res.status(400).json({ error: 'target_url required for WEBHOOK/SLACK triggers' });
    return;
  }
  const id = uuidv4();
  const empId = (req as unknown as { user?: { empId?: string } }).user?.empId ?? null;
  await execute(
    `INSERT INTO event_triggers
       (id, event_type, name, description, filter_json, action_type, action_config, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      parsed.data.event_type,
      parsed.data.name,
      parsed.data.description ?? null,
      parsed.data.filter_json ? JSON.stringify(parsed.data.filter_json) : null,
      action_type,
      JSON.stringify(action_config),
      empId,
    ],
  );
  res.status(201).json({ id });
}));

router.put('/triggers/:id', asyncHandler(async (req: Request, res: Response) => {
  const parsed = eventTriggerSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }
  const partial = parsed.data;
  let actionType: string | null = null;
  let actionConfig: string | null = null;

  if (partial.channel || partial.target_url || partial.secret || partial.action_type) {
    const resolved = resolveTriggerAction(partial as z.infer<typeof eventTriggerSchema>);
    actionType = resolved.action_type;
    actionConfig = JSON.stringify(resolved.action_config);
  } else if (partial.action_config) {
    actionConfig = JSON.stringify(partial.action_config);
    actionType = partial.action_type ?? null;
  }

  await execute(
    `UPDATE event_triggers SET
       event_type = COALESCE(?, event_type),
       name = COALESCE(?, name),
       description = COALESCE(?, description),
       action_type = COALESCE(?, action_type),
       action_config = COALESCE(?, action_config),
       active = COALESCE(?, active),
       updated_at = UTC_TIMESTAMP()
     WHERE id = ?`,
    [
      partial.event_type ?? null,
      partial.name ?? null,
      partial.description ?? null,
      actionType,
      actionConfig,
      partial.active ?? null,
      req.params['id'],
    ],
  );
  res.json({ success: true });
}));

router.delete('/triggers/:id', asyncHandler(async (req: Request, res: Response) => {
  await execute(`DELETE FROM event_triggers WHERE id=?`, [req.params['id']]);
  res.json({ success: true });
}));

export default router;
