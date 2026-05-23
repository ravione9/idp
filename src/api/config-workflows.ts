/**
 * Config — Workflows + Event Triggers API
 * Mounted at /api/admin/workflows
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../auth/middleware.js';
import { requireRole } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import { query, execute } from '../db/connection.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('ADMIN', 'SUPER_ADMIN'));

// ── Workflow Definitions ───────────────────────────────────────────────────

router.get('/definitions', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await query(`SELECT * FROM workflow_definitions ORDER BY name`, []);
  res.json({ data: rows });
}));

router.post('/definitions', asyncHandler(async (req: Request, res: Response) => {
  const { name, description, trigger_event, steps_json } = req.body as {
    name: string; description?: string; trigger_event?: string; steps_json?: unknown;
  };
  if (!name) { res.status(400).json({ error: 'name required' }); return; }
  const id = uuidv4();
  const empId = (req as unknown as { user?: { empId?: string } }).user?.empId ?? null;
  await execute(
    `INSERT INTO workflow_definitions
       (id, name, description, trigger_event, steps_json, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, name, description ?? null, trigger_event ?? null,
     steps_json ? JSON.stringify(steps_json) : null, empId],
  );
  res.status(201).json({ id });
}));

router.put('/definitions/:id', asyncHandler(async (req: Request, res: Response) => {
  const { name, description, trigger_event, steps_json, active } = req.body as {
    name?: string; description?: string; trigger_event?: string;
    steps_json?: unknown; active?: number;
  };
  await execute(
    `UPDATE workflow_definitions SET
       name = COALESCE(?, name),
       description = COALESCE(?, description),
       trigger_event = COALESCE(?, trigger_event),
       steps_json = COALESCE(?, steps_json),
       active = COALESCE(?, active),
       updated_at = UTC_TIMESTAMP()
     WHERE id = ?`,
    [name ?? null, description ?? null, trigger_event ?? null,
     steps_json ? JSON.stringify(steps_json) : null,
     active ?? null, req.params['id']],
  );
  res.json({ success: true });
}));

router.delete('/definitions/:id', asyncHandler(async (req: Request, res: Response) => {
  await execute(`UPDATE workflow_definitions SET active=0, updated_at=UTC_TIMESTAMP() WHERE id=?`, [req.params['id']]);
  res.json({ success: true });
}));

// ── Event Triggers ────────────────────────────────────────────────────────

router.get('/triggers', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await query(`SELECT * FROM event_triggers ORDER BY event_type, name`, []);
  res.json({ data: rows });
}));

router.post('/triggers', asyncHandler(async (req: Request, res: Response) => {
  const { event_type, name, description, filter_json, action_type, action_config } = req.body as {
    event_type: string; name: string; description?: string;
    filter_json?: unknown; action_type: string; action_config: unknown;
  };
  if (!event_type || !name || !action_type || !action_config) {
    res.status(400).json({ error: 'event_type, name, action_type, action_config required' });
    return;
  }
  const id = uuidv4();
  const empId = (req as unknown as { user?: { empId?: string } }).user?.empId ?? null;
  await execute(
    `INSERT INTO event_triggers
       (id, event_type, name, description, filter_json, action_type, action_config, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, event_type, name, description ?? null,
     filter_json ? JSON.stringify(filter_json) : null,
     action_type, JSON.stringify(action_config), empId],
  );
  res.status(201).json({ id });
}));

router.put('/triggers/:id', asyncHandler(async (req: Request, res: Response) => {
  const { event_type, name, description, action_type, action_config, active } = req.body as {
    event_type?: string; name?: string; description?: string;
    action_type?: string; action_config?: unknown; active?: number;
  };
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
    [event_type ?? null, name ?? null, description ?? null,
     action_type ?? null,
     action_config ? JSON.stringify(action_config) : null,
     active ?? null, req.params['id']],
  );
  res.json({ success: true });
}));

router.delete('/triggers/:id', asyncHandler(async (req: Request, res: Response) => {
  await execute(`DELETE FROM event_triggers WHERE id=?`, [req.params['id']]);
  res.json({ success: true });
}));

export default router;
