/**
 * Config — Password Policies API
 * Mounted at /api/admin/password-policies
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../auth/middleware.js';
import { requireRole } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import { query, queryOne, execute } from '../db/connection.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('ADMIN', 'SUPER_ADMIN'));

// GET /
router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await query(`SELECT * FROM password_policies ORDER BY name`, []);
  res.json({ data: rows });
}));

// POST /
router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const {
    name, min_length = 10, require_uppercase = 1, require_lowercase = 1,
    require_digits = 1, require_special = 0, history_count = 5,
    max_age_days = 90, lockout_attempts = 10, lockout_duration_min = 30,
    breach_check = 0, is_default = 0,
  } = req.body as Record<string, unknown>;
  if (!name) { res.status(400).json({ error: 'name required' }); return; }
  const id = uuidv4();
  const empId = (req as unknown as { user?: { empId?: string } }).user?.empId ?? null;

  if (is_default) {
    await execute(`UPDATE password_policies SET is_default = 0`, []);
  }

  await execute(
    `INSERT INTO password_policies
       (id, name, min_length, require_uppercase, require_lowercase,
        require_digits, require_special, history_count, max_age_days,
        lockout_attempts, lockout_duration_min, breach_check, is_default, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, min_length, require_uppercase, require_lowercase,
     require_digits, require_special, history_count, max_age_days,
     lockout_attempts, lockout_duration_min, breach_check, is_default, empId],
  );
  res.status(201).json({ id });
}));

// PUT /:id
router.put('/:id', asyncHandler(async (req: Request, res: Response) => {
  const {
    name, min_length, require_uppercase, require_lowercase,
    require_digits, require_special, history_count,
    max_age_days, lockout_attempts, lockout_duration_min,
    breach_check, is_default,
  } = req.body as Record<string, unknown>;

  if (is_default) {
    await execute(`UPDATE password_policies SET is_default = 0 WHERE id != ?`, [req.params['id']]);
  }

  await execute(
    `UPDATE password_policies SET
       name = COALESCE(?, name),
       min_length = COALESCE(?, min_length),
       require_uppercase = COALESCE(?, require_uppercase),
       require_lowercase = COALESCE(?, require_lowercase),
       require_digits = COALESCE(?, require_digits),
       require_special = COALESCE(?, require_special),
       history_count = COALESCE(?, history_count),
       max_age_days = COALESCE(?, max_age_days),
       lockout_attempts = COALESCE(?, lockout_attempts),
       lockout_duration_min = COALESCE(?, lockout_duration_min),
       breach_check = COALESCE(?, breach_check),
       is_default = COALESCE(?, is_default),
       updated_at = UTC_TIMESTAMP()
     WHERE id = ?`,
    [name ?? null, min_length ?? null, require_uppercase ?? null,
     require_lowercase ?? null, require_digits ?? null, require_special ?? null,
     history_count ?? null, max_age_days ?? null, lockout_attempts ?? null,
     lockout_duration_min ?? null, breach_check ?? null, is_default ?? null,
     req.params['id']],
  );
  res.json({ success: true });
}));

// DELETE /:id
router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  const pol = await queryOne<{ is_default: number }>(
    `SELECT is_default FROM password_policies WHERE id = ?`, [req.params['id']],
  );
  if (pol?.is_default) {
    res.status(400).json({ error: 'Cannot delete the default password policy.' });
    return;
  }
  await execute(`DELETE FROM password_policies WHERE id = ?`, [req.params['id']]);
  res.json({ success: true });
}));

export default router;
