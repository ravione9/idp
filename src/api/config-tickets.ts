/**
 * Config — Tickets API
 * Mounted at /api/admin/tickets
 * Auth required; admins see all, regular users see own.
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../utils/async-handler.js';
import { query, queryOne, execute } from '../db/connection.js';

type AuthRequest = Request;

const router = Router();
router.use(requireAuth);

const ADMIN_ROLES = ['ADMIN', 'SUPER_ADMIN'];

// GET /
router.get('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const empId = req.user?.empId;
  const isAdmin = ADMIN_ROLES.includes(req.user?.role ?? '');
  const { status, category } = req.query as { status?: string; category?: string };

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (!isAdmin) {
    conditions.push('requester_id = ?');
    params.push(empId);
  }
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (category) { conditions.push('category = ?'); params.push(category); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await query(
    `SELECT t.*, e.full_name AS requester_name
     FROM tickets t
     LEFT JOIN employees e ON e.emp_id = t.requester_id
     ${where}
     ORDER BY t.created_at DESC LIMIT 200`,
    params,
  );
  res.json({ data: rows });
}));

// POST /
router.post('/', asyncHandler(async (req: AuthRequest, res: Response) => {
  const { category, subject, description } = req.body as {
    category: string; subject: string; description?: string;
  };
  if (!category || !subject) { res.status(400).json({ error: 'category and subject required' }); return; }
  const id = uuidv4();
  await execute(
    `INSERT INTO tickets (id, category, subject, description, requester_id, status, priority)
     VALUES (?, ?, ?, ?, ?, 'OPEN', 'MEDIUM')`,
    [id, category, subject, description ?? null, req.user?.empId],
  );
  res.status(201).json({ id });
}));

// PUT /:id — admin only: update status, assignee, resolution
router.put('/:id', asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!ADMIN_ROLES.includes(req.user?.role ?? '')) {
    res.status(403).json({ error: 'Forbidden' }); return;
  }
  const { status, assignee_id, resolution, priority } = req.body as {
    status?: string; assignee_id?: string; resolution?: string; priority?: string;
  };
  await execute(
    `UPDATE tickets SET
       status = COALESCE(?, status),
       assignee_id = COALESCE(?, assignee_id),
       resolution = COALESCE(?, resolution),
       priority = COALESCE(?, priority),
       updated_at = UTC_TIMESTAMP()
     WHERE id = ?`,
    [status ?? null, assignee_id ?? null, resolution ?? null, priority ?? null, req.params['id']],
  );
  res.json({ success: true });
}));

// GET /:id
router.get('/:id', asyncHandler(async (req: AuthRequest, res: Response) => {
  const empId = req.user?.empId;
  const isAdmin = ADMIN_ROLES.includes(req.user?.role ?? '');
  const ticket = await queryOne<{ requester_id: string }>(
    `SELECT * FROM tickets WHERE id = ?`, [req.params['id']],
  );
  if (!ticket) { res.status(404).json({ error: 'Not found' }); return; }
  if (!isAdmin && ticket.requester_id !== empId) {
    res.status(403).json({ error: 'Forbidden' }); return;
  }
  res.json(ticket);
}));

export default router;
