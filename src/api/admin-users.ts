/**
 * Admin — Unified User Directory API
 * Mounted at /api/admin/users
 *
 * Endpoints:
 *   GET    /                              — list employees with linked identity sources
 *   GET    /:empId                        — full profile with identity links + login history
 *   POST   /local                         — create a brand-new local employee + local account
 *   POST   /:empId/reset-password         — admin-initiated password reset with multi-source writeback
 *   POST   /:empId/link-identity          — manually attach an identity link (AD / Google / etc.)
 *   DELETE /:empId/identity-links/:linkId — remove an identity link
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import { requireAuth } from '../auth/middleware.js';
import { requireRole } from '../auth/rbac.js';
import { query, queryOne, execute } from '../db/connection.js';
import { writebackPassword } from '../services/password-writeback.js';
import logger from '../utils/logger.js';
import { z } from 'zod';

const router = Router();
router.use(requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'));

// ---------------------------------------------------------------------------
// GET /  — paginated employee list with linked identity sources
// ---------------------------------------------------------------------------
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const limit  = Math.min(parseInt((req.query['limit']  as string) ?? '100', 10), 500);
  const offset = parseInt((req.query['offset'] as string) ?? '0', 10);
  const search = (req.query['q']      as string)?.trim() ?? '';
  const state  = (req.query['state']  as string)?.trim() ?? '';
  const source = (req.query['source'] as string)?.trim() ?? '';   // e.g. 'AD', 'GOOGLE', 'LOCAL'

  const where: string[] = [];
  const params: unknown[] = [];

  if (search) {
    where.push('(e.full_name LIKE ? OR e.email_corp LIKE ? OR e.emp_id LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  if (state) {
    where.push('e.ilg_state = ?');
    params.push(state);
  }
  if (source === 'LOCAL') {
    where.push('la.id IS NOT NULL');
  } else if (source) {
    // Must have an ACTIVE link for that system
    where.push(`EXISTS (SELECT 1 FROM identity_links il WHERE il.emp_id = e.emp_id AND il.system = ? AND il.status = 'ACTIVE')`);
    params.push(source);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await query<Record<string, unknown>>(
    `SELECT e.emp_id, e.full_name, e.email_corp, e.dept_id, e.employment_type,
            e.ilg_state, e.ilg_state_since, e.hire_date, e.manager_emp_id,
            la.role AS admin_role, la.last_login_at, la.active AS local_active,
            COALESCE(
              GROUP_CONCAT(DISTINCT il.system ORDER BY il.system SEPARATOR ','), ''
            ) AS identity_sources,
            COUNT(DISTINCT il.id) AS identity_link_count
       FROM employees e
       LEFT JOIN local_accounts la ON la.emp_id = e.emp_id AND la.active = 1
       LEFT JOIN identity_links il ON il.emp_id = e.emp_id AND il.status = 'ACTIVE'
       ${whereSql}
       GROUP BY e.emp_id, e.full_name, e.email_corp, e.dept_id, e.employment_type,
                e.ilg_state, e.ilg_state_since, e.hire_date, e.manager_emp_id,
                la.role, la.last_login_at, la.active
       ORDER BY e.full_name ASC
       LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  const total = await queryOne<{ n: number }>(
    `SELECT COUNT(DISTINCT e.emp_id) AS n
       FROM employees e
       LEFT JOIN local_accounts la ON la.emp_id = e.emp_id AND la.active = 1
       ${whereSql}`,
    params,
  );

  res.json({ data: rows, total: total?.n ?? 0, limit, offset });
});

// ---------------------------------------------------------------------------
// GET /:empId  — full profile: employee + all identity links + recent logins
// ---------------------------------------------------------------------------
router.get('/:empId', async (req: Request, res: Response): Promise<void> => {
  const { empId } = req.params;

  const employee = await queryOne<Record<string, unknown>>(
    `SELECT e.*,
            m.full_name  AS manager_name,
            m.email_corp AS manager_email,
            la.role      AS admin_role,
            la.last_login_at,
            la.active    AS local_active
       FROM employees e
       LEFT JOIN employees    m  ON m.emp_id = e.manager_emp_id
       LEFT JOIN local_accounts la ON la.emp_id = e.emp_id AND la.active = 1
      WHERE e.emp_id = ?`,
    [empId],
  );
  if (!employee) { res.status(404).json({ error: 'Employee not found' }); return; }

  const identityLinks = await query<Record<string, unknown>>(
    `SELECT id, system, external_id, status, last_synced_at, drift_flag, auth_kind
       FROM identity_links WHERE emp_id = ? ORDER BY system ASC`,
    [empId],
  );

  const recentLogins = await query<Record<string, unknown>>(
    `SELECT session_id, iss, ip, user_agent, created_at AS started_at, last_active_at
       FROM idp_sessions WHERE emp_id = ? AND revoked_at IS NULL
       ORDER BY created_at DESC LIMIT 10`,
    [empId],
  );

  const writebackLog = await query<Record<string, unknown>>(
    `SELECT target_system, status, error, initiated_by, created_at
       FROM password_writeback_log WHERE emp_id = ? ORDER BY created_at DESC LIMIT 10`,
    [empId],
  );

  res.json({
    employee,
    identityLinks,
    recentLogins,
    writebackLog,
  });
});

// ---------------------------------------------------------------------------
// POST /local  — create a brand-new local employee + local account
// ---------------------------------------------------------------------------
const createLocalSchema = z.object({
  fullName:   z.string().min(2).max(200),
  email:      z.string().email(),
  password:   z.string().min(10),
  role:       z.enum(['USER','MANAGER','HRBP','ADMIN','SUPER_ADMIN']).default('USER'),
  deptId:     z.string().max(50).optional(),
  empType:    z.enum(['CORPORATE','STORE','PLANT','DC']).default('CORPORATE'),
  managerId:  z.string().max(20).optional(),
});

router.post('/local', async (req: Request, res: Response): Promise<void> => {
  const parsed = createLocalSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }
  const d = parsed.data;

  // Check email uniqueness
  const existing = await queryOne<{ c: number }>(
    `SELECT COUNT(*) AS c FROM employees WHERE email_corp = ?`, [d.email],
  );
  if ((existing?.c ?? 0) > 0) {
    res.status(409).json({ error: 'An employee with this email already exists' });
    return;
  }

  const empId = `LOC-${uuidv4().replace(/-/g,'').slice(0,12).toUpperCase()}`;
  const hash  = await bcrypt.hash(d.password, 10);
  const adminId = (req as unknown as { user?: { empId?: string } }).user?.empId ?? 'system';

  // Insert employee row
  await execute(
    `INSERT INTO employees
       (emp_id, full_name, email_corp, role, employment_type, dept_id, manager_emp_id,
        ilg_state, hrms_status, hire_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 'ACTIVE', UTC_DATE())`,
    [empId, d.fullName, d.email, d.role, d.empType,
     d.deptId ?? null, d.managerId ?? null],
  );

  // Insert local account (role enum expanded in migration 008)
  await execute(
    `INSERT INTO local_accounts (emp_id, email, password_hash, role, created_by, active)
     VALUES (?, ?, ?, ?, ?, 1)`,
    [empId, d.email, hash, d.role, adminId],
  );

  logger.info({ empId, email: d.email, createdBy: adminId }, 'Local user created');
  res.status(201).json({ empId, email: d.email });
});

// ---------------------------------------------------------------------------
// POST /:empId/reset-password  — admin reset + multi-source writeback
// ---------------------------------------------------------------------------
const resetPwdSchema = z.object({
  newPassword:  z.string().min(10),
  notifyUser:   z.boolean().default(false),
});

router.post('/:empId/reset-password', async (req: Request, res: Response): Promise<void> => {
  const { empId } = req.params;
  const parsed = resetPwdSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }
  const { newPassword } = parsed.data;
  const adminId = (req as unknown as { user?: { empId?: string } }).user?.empId ?? 'admin';

  // 1. Update local account password if exists
  const localAccount = await queryOne<{ id: number }>(
    `SELECT id FROM local_accounts WHERE emp_id = ? AND active = 1`, [empId],
  );
  const localResults: { system: string; status: string; error?: string }[] = [];
  if (localAccount) {
    const hash = await bcrypt.hash(newPassword, 10);
    await execute(
      `UPDATE local_accounts SET password_hash = ? WHERE emp_id = ? AND active = 1`,
      [hash, empId],
    );
    localResults.push({ system: 'LOCAL', status: 'SUCCESS' });
    logger.info({ empId, adminId }, 'Local password reset by admin');
  }

  // 2. Writeback to AD and Google (if linked)
  let writebackResults: { system: string; status: string; error?: string }[] = [];
  try {
    writebackResults = await writebackPassword(empId, newPassword, adminId);
  } catch (err) {
    logger.warn({ empId, err }, 'Password writeback threw unexpectedly');
    writebackResults = [{ system: 'WRITEBACK', status: 'FAILED', error: String(err) }];
  }

  const allResults = [...localResults, ...writebackResults];
  const allSucceeded = allResults.length > 0 && allResults.every(r => r.status === 'SUCCESS');
  const anyFailed = allResults.some(r => r.status === 'FAILED');

  res.json({
    success: !anyFailed,
    results: allResults,
    summary: allSucceeded
      ? 'Password reset across all linked systems'
      : anyFailed
        ? 'Password reset with some failures — check results'
        : 'Password reset (no linked external systems found)',
  });
});

// ---------------------------------------------------------------------------
// POST /:empId/link-identity  — manually attach an identity link
// ---------------------------------------------------------------------------
const linkSchema = z.object({
  system:      z.enum(['GOOGLE','AD','ZOHO','SLACK','GITHUB','HRMS','NEXSID','SALESMAN_OTP','BIGQUERY','AWS_IDC']),
  externalId:  z.string().min(1).max(255),
  authKind:    z.enum(['OIDC','SAML','LDAP','OTP','BIOMETRIC']).default('LDAP'),
});

router.post('/:empId/link-identity', async (req: Request, res: Response): Promise<void> => {
  const { empId } = req.params;
  const parsed = linkSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }
  const { system, externalId, authKind } = parsed.data;

  // Verify employee exists
  const emp = await queryOne<{ emp_id: string }>(
    `SELECT emp_id FROM employees WHERE emp_id = ?`, [empId],
  );
  if (!emp) { res.status(404).json({ error: 'Employee not found' }); return; }

  await execute(
    `INSERT INTO identity_links (emp_id, system, external_id, status, auth_kind)
     VALUES (?, ?, ?, 'ACTIVE', ?)
     ON DUPLICATE KEY UPDATE status='ACTIVE', auth_kind=VALUES(auth_kind), last_synced_at=UTC_TIMESTAMP()`,
    [empId, system, externalId, authKind],
  );

  logger.info({ empId, system, externalId }, 'Identity link added by admin');
  res.status(201).json({ success: true });
});

// ---------------------------------------------------------------------------
// DELETE /:empId/identity-links/:linkId  — remove an identity link
// ---------------------------------------------------------------------------
router.delete('/:empId/identity-links/:linkId', async (req: Request, res: Response): Promise<void> => {
  const { empId, linkId } = req.params;
  await execute(
    `UPDATE identity_links SET status='DELETED' WHERE id = ? AND emp_id = ?`,
    [linkId, empId],
  );
  logger.info({ empId, linkId }, 'Identity link removed by admin');
  res.json({ success: true });
});

export default router;
