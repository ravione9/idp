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
import { backfillAdIdentityLinkIfMissing } from '../services/ad-sync.js';
import { hashPassword } from '../services/local-admin.js';
import { asyncHandler } from '../utils/async-handler.js';
import logger from '../utils/logger.js';
import { z } from 'zod';
import qrcode from 'qrcode';
import {
  getMfaStatus,
  startEnrollment,
  confirmEnrollment,
  disableMfa,
  regenerateBackupCodes,
} from '../auth/mfa.js';

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
    where.push(`EXISTS (SELECT 1 FROM identity_links il WHERE il.emp_id = e.emp_id AND il.\`system\` = ? AND il.status = 'ACTIVE')`);
    params.push(source);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await query<Record<string, unknown>>(
    `SELECT e.emp_id, e.full_name, e.email_corp, e.dept_id, e.employment_type,
            e.ilg_state, e.ilg_state_since, e.hire_date, e.manager_emp_id,
            la.role AS admin_role, la.last_login_at, la.active AS local_active,
            COALESCE(
              GROUP_CONCAT(DISTINCT il.\`system\` ORDER BY il.\`system\` SEPARATOR ','), ''
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

  const employeeRow = await queryOne<Record<string, unknown>>(
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
  if (!employeeRow) { res.status(404).json({ error: 'Employee not found' }); return; }

  let employee = employeeRow;

  // Secondary queries are wrapped individually — a missing table never breaks the profile.
  let identityLinks: Record<string, unknown>[] = [];
  try {
    identityLinks = await query<Record<string, unknown>>(
      `SELECT id, \`system\`, external_id, status, last_synced_at, drift_flag, auth_kind
         FROM identity_links WHERE emp_id = ? AND status != 'DELETED' ORDER BY \`system\` ASC`,
      [empId],
    );
  } catch (err) {
    logger.warn({ empId, err }, 'identity_links query failed (table may not exist yet)');
  }

  if (
    typeof employee['email_corp'] === 'string'
    && employee['email_corp']
    && (empId.startsWith('AD-') || identityLinks.every((l) => l['system'] !== 'AD'))
  ) {
    const backfill = await backfillAdIdentityLinkIfMissing(empId, employee['email_corp']);
    if (backfill.changed) {
      const effectiveEmpId = backfill.empId;
      if (effectiveEmpId !== empId) {
        const migrated = await queryOne<Record<string, unknown>>(
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
          [effectiveEmpId],
        );
        if (migrated) employee = migrated;
      }
      identityLinks = await query<Record<string, unknown>>(
        `SELECT id, \`system\`, external_id, status, last_synced_at, drift_flag, auth_kind
           FROM identity_links WHERE emp_id = ? AND status != 'DELETED' ORDER BY \`system\` ASC`,
        [backfill.empId],
      );
    }
  }

  const profileEmpId = String(employee['emp_id'] ?? empId);

  let recentLogins: Record<string, unknown>[] = [];
  try {
    recentLogins = await query<Record<string, unknown>>(
      `SELECT session_id, iss, ip, user_agent, created_at AS started_at, last_active_at
         FROM idp_sessions WHERE emp_id = ? AND revoked_at IS NULL
         ORDER BY created_at DESC LIMIT 10`,
      [profileEmpId],
    );
  } catch (err) {
    logger.warn({ empId: profileEmpId, err }, 'idp_sessions query failed');
  }

  let writebackLog: Record<string, unknown>[] = [];
  try {
    writebackLog = await query<Record<string, unknown>>(
      `SELECT target_system, status, error, initiated_by, ts AS created_at
         FROM password_writeback_log WHERE emp_id = ? ORDER BY ts DESC LIMIT 10`,
      [profileEmpId],
    );
  } catch (err) {
    logger.warn({ empId: profileEmpId, err }, 'password_writeback_log query failed');
  }

  let mfaStatus: Record<string, unknown> = {
    enrolled: false,
    enabled: false,
    remainingBackupCodes: 0,
    lastUsedAt: null,
  };
  try {
    mfaStatus = await getMfaStatus(profileEmpId) as unknown as Record<string, unknown>;
  } catch (err) {
    logger.warn({ empId: profileEmpId, err }, 'mfa status query failed');
  }

  res.json({
    employee,
    identityLinks,
    recentLogins,
    writebackLog,
    mfaStatus,
    ...(profileEmpId !== empId ? { migratedFrom: empId } : {}),
  });
});

// ---------------------------------------------------------------------------
// MFA admin endpoints — manage MFA for a specific employee
// ---------------------------------------------------------------------------
const mfaConfirmSchema = z.object({ code: z.string().regex(/^\d{6}$/) });

router.get('/:empId/mfa', async (req: Request, res: Response): Promise<void> => {
  const { empId } = req.params;
  const emp = await queryOne<{ emp_id: string; email_corp: string }>(
    `SELECT emp_id, email_corp FROM employees WHERE emp_id = ?`,
    [empId],
  );
  if (!emp) { res.status(404).json({ error: 'Employee not found' }); return; }
  const status = await getMfaStatus(emp.emp_id);
  res.json(status);
});

router.post('/:empId/mfa/enroll', async (req: Request, res: Response): Promise<void> => {
  const { empId } = req.params;
  const emp = await queryOne<{ emp_id: string; email_corp: string }>(
    `SELECT emp_id, email_corp FROM employees WHERE emp_id = ?`,
    [empId],
  );
  if (!emp) { res.status(404).json({ error: 'Employee not found' }); return; }

  const result = await startEnrollment(emp.emp_id, emp.email_corp || emp.emp_id);
  const qrDataUrl = await qrcode.toDataURL(result.otpauthUrl, { margin: 1, width: 220 });
  logger.info({ empId: emp.emp_id }, 'Admin started MFA enrollment for user');
  res.json({
    secret: result.secret,
    otpauthUrl: result.otpauthUrl,
    qrDataUrl,
  });
});

router.post('/:empId/mfa/confirm', async (req: Request, res: Response): Promise<void> => {
  const { empId } = req.params;
  const parsed = mfaConfirmSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Code must be 6 digits' });
    return;
  }

  const emp = await queryOne<{ emp_id: string }>(
    `SELECT emp_id FROM employees WHERE emp_id = ?`,
    [empId],
  );
  if (!emp) { res.status(404).json({ error: 'Employee not found' }); return; }

  try {
    const { backupCodes } = await confirmEnrollment(emp.emp_id, parsed.data.code);
    logger.info({ empId: emp.emp_id }, 'Admin confirmed MFA enrollment for user');
    res.json({ success: true, backupCodes });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Verification failed' });
  }
});

router.post('/:empId/mfa/disable', async (req: Request, res: Response): Promise<void> => {
  const { empId } = req.params;
  const emp = await queryOne<{ emp_id: string }>(
    `SELECT emp_id FROM employees WHERE emp_id = ?`,
    [empId],
  );
  if (!emp) { res.status(404).json({ error: 'Employee not found' }); return; }

  await disableMfa(emp.emp_id);
  logger.info({ empId: emp.emp_id }, 'Admin disabled MFA for user');
  res.json({ success: true });
});

router.post('/:empId/mfa/regenerate-codes', async (req: Request, res: Response): Promise<void> => {
  const { empId } = req.params;
  const emp = await queryOne<{ emp_id: string }>(
    `SELECT emp_id FROM employees WHERE emp_id = ?`,
    [empId],
  );
  if (!emp) { res.status(404).json({ error: 'Employee not found' }); return; }

  try {
    const codes = await regenerateBackupCodes(emp.emp_id);
    logger.info({ empId: emp.emp_id }, 'Admin regenerated MFA backup codes for user');
    res.json({ backupCodes: codes });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed' });
  }
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

router.post('/:empId/reset-password', asyncHandler(async (req: Request, res: Response) => {
  const { empId } = req.params;
  const parsed = resetPwdSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }
  const { newPassword, notifyUser } = parsed.data;
  const adminId = (req as unknown as { user?: { empId?: string } }).user?.empId ?? 'admin';

  const employee = await queryOne<{ emp_id: string; email_corp: string; role: string | null }>(
    `SELECT emp_id, email_corp, role FROM employees WHERE emp_id = ?`,
    [empId],
  );
  if (!employee) {
    res.status(404).json({ error: 'Employee not found' });
    return;
  }

  const localResults: { system: string; status: string; error?: string }[] = [];

  // 1. Local IdP password (email/password login at /login)
  const localAccount = await queryOne<{ id: number }>(
    `SELECT id FROM local_accounts WHERE emp_id = ? AND active = 1`, [empId],
  );
  const passwordHash = await hashPassword(newPassword);

  if (localAccount) {
    await execute(
      `UPDATE local_accounts SET password_hash = ? WHERE emp_id = ? AND active = 1`,
      [passwordHash, empId],
    );
    localResults.push({ system: 'LOCAL', status: 'SUCCESS' });
    logger.info({ empId, adminId }, 'Local password reset by admin');
  } else if (employee.email_corp) {
    const email = employee.email_corp.toLowerCase().trim();
    const emailTaken = await queryOne<{ emp_id: string }>(
      `SELECT emp_id FROM local_accounts WHERE email = ? AND active = 1`,
      [email],
    );
    if (emailTaken && emailTaken.emp_id !== empId) {
      localResults.push({
        system: 'LOCAL',
        status: 'FAILED',
        error: `Corporate email already tied to local account ${emailTaken.emp_id}`,
      });
    } else {
      const localRole = ['ADMIN', 'SUPER_ADMIN', 'HRBP', 'MANAGER'].includes(employee.role ?? '')
        ? employee.role!
        : 'USER';
      await execute(
        `INSERT INTO local_accounts (emp_id, email, password_hash, role, created_by, active)
         VALUES (?, ?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), active = 1`,
        [empId, email, passwordHash, localRole, adminId],
      );
      localResults.push({ system: 'LOCAL', status: 'SUCCESS' });
      logger.info({ empId, adminId }, 'Local account provisioned during admin password reset');
    }
  } else {
    localResults.push({
      system: 'LOCAL',
      status: 'SKIPPED',
      error: 'No local login account and no corporate email on file',
    });
  }

  // 2. Writeback to AD and Google (if linked)
  let writebackResults: { system: string; status: string; error?: string }[] = [];
  try {
    writebackResults = await writebackPassword(empId, newPassword, adminId);
  } catch (err) {
    logger.warn({ empId, err }, 'Password writeback threw unexpectedly');
    writebackResults = [{ system: 'WRITEBACK', status: 'FAILED', error: String(err) }];
  }

  if (notifyUser) {
    logger.info({ empId, adminId }, 'Password reset notifyUser requested (email delivery not yet implemented)');
  }

  const allResults = [...localResults, ...writebackResults];
  const anySuccess = allResults.some((r) => r.status === 'SUCCESS');
  const anyFailed = allResults.some((r) => r.status === 'FAILED');

  if (!anySuccess) {
    res.status(400).json({
      success: false,
      results: allResults,
      summary: 'Password was not updated in any system — check results below',
    });
    return;
  }

  res.json({
    success: !anyFailed,
    results: allResults,
    summary: !anyFailed
      ? 'Password reset across all linked systems'
      : 'Password reset with some failures — check results',
  });
}));

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
    `INSERT INTO identity_links (emp_id, \`system\`, external_id, status, auth_kind)
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
