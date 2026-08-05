/**
 * Config — Notifications API
 * Mounted at /api/admin/notifications
 */
import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { requireRole, requirePortalModule } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import { query, queryOne, execute } from '../db/connection.js';
import { sendNotification, dispatchPendingNotifications, deliverEmail } from '../services/notification.js';
import { v4 as uuidv4 } from 'uuid';

async function resolveEmployeeByRecipient(input: string): Promise<{ emp_id: string; email_corp: string | null } | null> {
  const r = input.trim();
  if (!r) return null;

  const byId = await queryOne<{ emp_id: string; email_corp: string | null }>(
    `SELECT emp_id, email_corp FROM employees WHERE emp_id = ? LIMIT 1`,
    [r],
  );
  if (byId) return byId;

  const email = r.toLowerCase();
  return queryOne<{ emp_id: string; email_corp: string | null }>(
    `SELECT emp_id, email_corp FROM employees
      WHERE LOWER(email_corp) = ? OR LOWER(COALESCE(email_personal, '')) = ?
      LIMIT 1`,
    [email, email],
  );
}

const router = Router();
router.use(requireAuth);
router.use(requireRole('ADMIN', 'SUPER_ADMIN'), requirePortalModule('workflows'));

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

// POST /test — send test notification
router.post('/test', requireRole('ADMIN', 'SUPER_ADMIN'), asyncHandler(async (req: Request, res: Response) => {
  const bodyIn = req.body as {
    recipientEmpId?: string; recipient?: string; channel?: string; subject: string; body: string;
  };
  let recipientEmpId = bodyIn.recipientEmpId?.trim();
  // Accept email/emp_id in legacy `recipient` field from UI.
  if (!recipientEmpId && bodyIn.recipient) {
    const emp = await resolveEmployeeByRecipient(bodyIn.recipient);
    recipientEmpId = emp?.emp_id;
  }
  if (!recipientEmpId || !bodyIn.subject || !bodyIn.body) {
    res.status(400).json({ error: 'recipientEmpId (or recipient), subject, body required' }); return;
  }
  const emp = await queryOne<{ emp_id: string; email_corp: string | null }>(
    `SELECT emp_id, email_corp FROM employees WHERE emp_id = ?`, [recipientEmpId],
  );
  if (!emp) { res.status(404).json({ error: 'Employee not found' }); return; }

  const channel = (bodyIn.channel ?? 'EMAIL') as 'EMAIL' | 'SLACK' | 'TEAMS' | 'IN_APP';
  if (channel === 'EMAIL') {
    const to = emp.email_corp?.trim();
    if (!to) {
      res.status(400).json({ error: 'Employee has no corporate email on file' });
      return;
    }
    try {
      await deliverEmail(to, bodyIn.subject, bodyIn.body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: `Email delivery failed: ${msg}` });
      return;
    }
    const notificationId = uuidv4();
    await execute(
      `INSERT INTO notifications
         (id, recipient_emp_id, recipient, channel, subject, body,
          template, template_id, payload, status, created_at, sent_at)
       VALUES (?, ?, ?, 'EMAIL', ?, ?, 'test', 'test', ?, 'SENT', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
      [
        notificationId,
        recipientEmpId,
        to,
        bodyIn.subject,
        bodyIn.body,
        JSON.stringify({ subject: bodyIn.subject, test: true }),
      ],
    );
    res.json({ success: true, sentTo: to });
    return;
  }

  await sendNotification({
    recipientEmpId,
    channel,
    subject: bodyIn.subject,
    body: bodyIn.body,
  });
  res.json({ success: true });
}));

// POST /dispatch-pending — trigger dispatch
router.post('/dispatch-pending', requireRole('ADMIN', 'SUPER_ADMIN'), asyncHandler(async (_req: Request, res: Response) => {
  const count = await dispatchPendingNotifications();
  res.json({ success: true, dispatched: count });
}));

export default router;
