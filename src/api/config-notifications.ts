/**
 * Config — Notifications API
 * Mounted at /api/admin/notifications
 */
import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { requireRole } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import { query, queryOne } from '../db/connection.js';
import { sendNotification, dispatchPendingNotifications } from '../services/notification.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('ADMIN', 'SUPER_ADMIN'));

// GET / — list notifications paginated
router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const { status, channel, limit: limitStr = '50', offset: offsetStr = '0' } = req.query as {
    status?: string; channel?: string; limit?: string; offset?: string;
  };
  const limit = Math.min(parseInt(limitStr, 10), 200);
  const offset = parseInt(offsetStr, 10);

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (status) { conditions.push('n.status = ?'); params.push(status); }
  if (channel) { conditions.push('n.channel = ?'); params.push(channel); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = await query(
    `SELECT n.*, e.full_name AS recipient_name
     FROM notifications n
     LEFT JOIN employees e ON e.emp_id = n.recipient_emp_id
     ${where}
     ORDER BY n.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  res.json({ data: rows });
}));

// GET /stats — counts by status and channel
router.get('/stats', asyncHandler(async (_req: Request, res: Response) => {
  const [byStatus, byChannel] = await Promise.all([
    query<{ status: string; count: number }>(
      `SELECT status, COUNT(*) AS count FROM notifications GROUP BY status`, [],
    ),
    query<{ channel: string; count: number }>(
      `SELECT channel, COUNT(*) AS count FROM notifications GROUP BY channel`, [],
    ),
  ]);
  res.json({ byStatus, byChannel });
}));

// POST /test — send test notification (SUPER_ADMIN)
router.post('/test', requireRole('SUPER_ADMIN'), asyncHandler(async (req: Request, res: Response) => {
  const { recipientEmpId, channel = 'EMAIL', subject, body } = req.body as {
    recipientEmpId: string; channel?: string; subject: string; body: string;
  };
  if (!recipientEmpId || !subject || !body) {
    res.status(400).json({ error: 'recipientEmpId, subject, body required' }); return;
  }
  const emp = await queryOne<{ emp_id: string }>(
    `SELECT emp_id FROM employees WHERE emp_id = ?`, [recipientEmpId],
  );
  if (!emp) { res.status(404).json({ error: 'Employee not found' }); return; }

  await sendNotification({
    recipientEmpId,
    channel: channel as 'EMAIL' | 'SLACK' | 'TEAMS' | 'IN_APP',
    subject,
    body,
  });
  res.json({ success: true });
}));

// POST /dispatch-pending — trigger dispatch (SUPER_ADMIN)
router.post('/dispatch-pending', requireRole('SUPER_ADMIN'), asyncHandler(async (_req: Request, res: Response) => {
  const count = await dispatchPendingNotifications();
  res.json({ success: true, dispatched: count });
}));

export default router;
