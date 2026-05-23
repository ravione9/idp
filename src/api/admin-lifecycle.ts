/**
 * Admin Lifecycle API
 * -------------------
 * Routes for suspending, unsuspending, terminating employees,
 * and viewing their lifecycle event history.
 *
 * All routes require ADMIN or SUPER_ADMIN role.
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { requireRole } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import { query } from '../db/connection.js';
import {
  suspendUser,
  unsuspendUser,
  terminateUser,
} from '../services/user-lifecycle.js';

const router = Router();

// All lifecycle routes require authentication + admin role
router.use(requireAuth);
router.use(requireRole('ADMIN', 'SUPER_ADMIN'));

// ---------------------------------------------------------------------------
// POST /:empId/suspend
// ---------------------------------------------------------------------------
router.post(
  '/:empId/suspend',
  asyncHandler(async (req: Request, res: Response) => {
    const { empId } = req.params as { empId: string };
    const reason = (req.body as Record<string, string>)['reason'] ?? '';
    const initiatedBy = req.user!.empId;

    try {
      await suspendUser(empId, reason, initiatedBy);
      res.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'Employee not found') {
        res.status(404).json({ error: msg });
        return;
      }
      throw err;
    }
  }),
);

// ---------------------------------------------------------------------------
// POST /:empId/unsuspend
// ---------------------------------------------------------------------------
router.post(
  '/:empId/unsuspend',
  asyncHandler(async (req: Request, res: Response) => {
    const { empId } = req.params as { empId: string };
    const reason = (req.body as Record<string, string>)['reason'] ?? '';
    const initiatedBy = req.user!.empId;

    try {
      await unsuspendUser(empId, reason, initiatedBy);
      res.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'Employee not found') {
        res.status(404).json({ error: msg });
        return;
      }
      throw err;
    }
  }),
);

// ---------------------------------------------------------------------------
// POST /:empId/terminate
// ---------------------------------------------------------------------------
router.post(
  '/:empId/terminate',
  asyncHandler(async (req: Request, res: Response) => {
    const { empId } = req.params as { empId: string };
    const reason = (req.body as Record<string, string>)['reason'] ?? '';
    const initiatedBy = req.user!.empId;

    try {
      await terminateUser(empId, reason, initiatedBy);
      res.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'Employee not found') {
        res.status(404).json({ error: msg });
        return;
      }
      throw err;
    }
  }),
);

// ---------------------------------------------------------------------------
// GET /:empId/lifecycle — list lifecycle events for an employee
// ---------------------------------------------------------------------------
router.get(
  '/:empId/lifecycle',
  asyncHandler(async (req: Request, res: Response) => {
    const { empId } = req.params as { empId: string };

    const events = await query<Record<string, unknown>>(
      `SELECT id, emp_id, event_type, old_state, new_state, reason, initiated_by, ts
         FROM lifecycle_events
        WHERE emp_id = ?
        ORDER BY ts DESC`,
      [empId],
    );

    res.json({ data: events });
  }),
);

export default router;
