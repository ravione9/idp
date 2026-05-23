/**
 * Config — General Settings API
 * Mounted at /api/admin/general-settings
 */
import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { requireRole } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import { queryOne, execute } from '../db/connection.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('SUPER_ADMIN'));

// GET /
router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const row = await queryOne(`SELECT * FROM general_settings WHERE id = 1`, []);
  res.json(row ?? { id: 1 });
}));

// PUT /
router.put('/', asyncHandler(async (req: Request, res: Response) => {
  const {
    display_name, support_email, default_session_hours,
    session_absolute_hours, password_min_length, mfa_grace_period_days,
    audit_retention_days, allow_google_login, allow_local_login,
    maintenance_mode, maintenance_msg,
  } = req.body as Record<string, unknown>;
  const empId = (req as unknown as { user?: { empId?: string } }).user?.empId ?? null;

  await execute(
    `INSERT INTO general_settings
       (id, display_name, support_email, default_session_hours,
        session_absolute_hours, password_min_length, mfa_grace_period_days,
        audit_retention_days, allow_google_login, allow_local_login,
        maintenance_mode, maintenance_msg, updated_by, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE
       display_name = VALUES(display_name),
       support_email = VALUES(support_email),
       default_session_hours = VALUES(default_session_hours),
       session_absolute_hours = VALUES(session_absolute_hours),
       password_min_length = VALUES(password_min_length),
       mfa_grace_period_days = VALUES(mfa_grace_period_days),
       audit_retention_days = VALUES(audit_retention_days),
       allow_google_login = VALUES(allow_google_login),
       allow_local_login = VALUES(allow_local_login),
       maintenance_mode = VALUES(maintenance_mode),
       maintenance_msg = VALUES(maintenance_msg),
       updated_by = VALUES(updated_by),
       updated_at = UTC_TIMESTAMP()`,
    [display_name ?? 'Lenskart IdP', support_email ?? null,
     default_session_hours ?? 8, session_absolute_hours ?? 24,
     password_min_length ?? 10, mfa_grace_period_days ?? 14,
     audit_retention_days ?? 365,
     allow_google_login !== undefined ? (allow_google_login ? 1 : 0) : 1,
     allow_local_login !== undefined ? (allow_local_login ? 1 : 0) : 1,
     maintenance_mode ? 1 : 0, maintenance_msg ?? null, empId],
  );
  res.json({ success: true });
}));

export default router;
