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
import { requireRole, requirePortalModule } from '../auth/rbac.js';
import { query, queryOne, execute } from '../db/connection.js';
import { writebackPassword, ensureWritebackIdentityLinks } from '../services/password-writeback.js';
import { backfillAdIdentityLinkIfMissing } from '../services/ad-sync.js';
import { assignPortalRole, hashPassword, revokePortalRole } from '../services/local-admin.js';
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
import { PORTAL_ACCESSIBLE_STATES } from '../fsm/states.js';
import { enforcePasswordPolicy } from '../services/password-policy.js';
import { appendAuditLog } from '../utils/audit-log.js';
import { writeDirectoryUserAudit } from '../services/google-attr-map.js';
import crypto from 'crypto';

const router = Router();
router.use(requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), requirePortalModule('identity_users'));

function parsePolicyStringArray(raw: unknown): string[] {
  const normalize = (arr: unknown[]): string[] => arr
    .map((v) => String(v ?? '').trim())
    .filter((v) => v.length > 0);

  if (Array.isArray(raw)) return normalize(raw);
  if (typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return normalize(parsed);
  } catch {
    // Fall back to comma-separated parsing.
  }
  return normalize(trimmed.split(','));
}

async function isUserExcludedFromPolicyMfa(empId: string): Promise<boolean> {
  try {
    const excludedRow = await queryOne<{ policy_value: string }>(
      `SELECT policy_value
         FROM mfa_policy
        WHERE policy_key = 'excluded_group_ids'
        LIMIT 1`,
      [],
    );
    if (!excludedRow?.policy_value) return false;

    const excludedGroupIds = parsePolicyStringArray(excludedRow.policy_value);
    if (excludedGroupIds.length === 0) return false;

    const placeholders = excludedGroupIds.map(() => '?').join(', ');
    const row = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n
         FROM group_members
        WHERE emp_id = ?
          AND group_id IN (${placeholders})`,
      [empId, ...excludedGroupIds],
    );
    return Number(row?.n ?? 0) > 0;
  } catch (err) {
    logger.warn({ empId, err }, 'MFA group exclusion lookup failed');
    return false;
  }
}

// ---------------------------------------------------------------------------
// GET /  — paginated employee list with linked identity sources
// ---------------------------------------------------------------------------
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const limit  = Math.min(parseInt((req.query['limit']  as string) ?? '100', 10), 500);
  const offset = parseInt((req.query['offset'] as string) ?? '0', 10);
  const search = (req.query['q']      as string)?.trim() ?? '';
  const state  = (req.query['state']  as string)?.trim() ?? '';
  const source = (req.query['source'] as string)?.trim() ?? '';   // e.g. 'AD', 'GOOGLE', 'LOCAL'
  const department = (req.query['department'] as string)?.trim() ?? '';
  const manager = (req.query['manager'] as string)?.trim() ?? '';
  const location = (req.query['location'] as string)?.trim() ?? '';
  const empType = (req.query['employeeType'] as string)?.trim() ?? '';
  const employeeId = (req.query['employeeId'] as string)?.trim() ?? '';
  const includeInactive = req.query['includeInactive'] === '1';

  const where: string[] = [];
  const params: unknown[] = [];

  if (search) {
    where.push('(e.full_name LIKE ? OR e.email_corp LIKE ? OR e.emp_id LIKE ? OR e.employee_number LIKE ? OR e.username LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like, like);
  }
  if (employeeId) {
    where.push('(e.emp_id = ? OR e.employee_number = ?)');
    params.push(employeeId, employeeId);
  }
  if (department) {
    where.push('e.dept_id = ?');
    params.push(department);
  }
  if (manager) {
    where.push('(e.manager_emp_id = ? OR e.manager_emp_id IN (SELECT emp_id FROM employees WHERE email_corp = ? OR full_name LIKE ?))');
    params.push(manager, manager.toLowerCase(), `%${manager}%`);
  }
  if (location) {
    where.push('(e.location LIKE ? OR e.city LIKE ?)');
    params.push(`%${location}%`, `%${location}%`);
  }
  if (empType) {
    where.push('e.employment_type = ?');
    params.push(empType);
  }
  if (state === 'SUSPENDED') {
    where.push(`e.ilg_state IN ('SUSPENDED_AUTO', 'SUSPENDED_HR')`);
  } else if (state) {
    where.push('e.ilg_state = ?');
    params.push(state);
  } else if (!includeInactive) {
    const placeholders = PORTAL_ACCESSIBLE_STATES.map(() => '?').join(', ');
    where.push(`e.ilg_state IN (${placeholders})`);
    params.push(...PORTAL_ACCESSIBLE_STATES);
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
    `SELECT e.emp_id, e.employee_number, e.full_name, e.first_name, e.last_name, e.username,
            e.email_corp, e.dept_id, e.role AS designation, e.employment_type,
            e.ilg_state, e.ilg_state_since, e.hire_date, e.manager_emp_id,
            e.mobile, e.location, e.cost_center, e.photo_url, e.attrs_synced_at, e.sync_status,
            CASE WHEN la.role IN ('ADMIN','SUPER_ADMIN','APP_CONTRIBUTOR','USER_GROUP_MANAGER','CUSTOM') THEN la.role ELSE NULL END AS portal_role,
            la.last_login_at, la.active AS local_active,
            COALESCE(
              GROUP_CONCAT(DISTINCT il.\`system\` ORDER BY il.\`system\` SEPARATOR ','), ''
            ) AS identity_sources,
            MAX(il.last_synced_at) AS last_synced_at,
            COUNT(DISTINCT il.id) AS identity_link_count
       FROM employees e
       LEFT JOIN local_accounts la ON la.emp_id = e.emp_id AND la.active = 1
       LEFT JOIN identity_links il ON il.emp_id = e.emp_id AND il.status = 'ACTIVE'
       ${whereSql}
       GROUP BY e.emp_id, e.employee_number, e.full_name, e.first_name, e.last_name, e.username,
                e.email_corp, e.dept_id, e.role, e.employment_type,
                e.ilg_state, e.ilg_state_since, e.hire_date, e.manager_emp_id,
                e.mobile, e.location, e.cost_center, e.photo_url, e.attrs_synced_at, e.sync_status,
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
// GET /export  — CSV export of directory users (must be before /:empId)
// ---------------------------------------------------------------------------
router.get('/export', asyncHandler(async (req: Request, res: Response) => {
  const source = (req.query['source'] as string)?.trim() ?? '';
  const state = (req.query['state'] as string)?.trim() ?? '';
  const where: string[] = [];
  const params: unknown[] = [];
  if (state) { where.push('e.ilg_state = ?'); params.push(state); }
  if (source === 'LOCAL') where.push('la.id IS NOT NULL');
  else if (source) {
    where.push(`EXISTS (SELECT 1 FROM identity_links il WHERE il.emp_id = e.emp_id AND il.\`system\` = ? AND il.status = 'ACTIVE')`);
    params.push(source);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = await query<Record<string, unknown>>(
    `SELECT e.emp_id, e.employee_number, e.first_name, e.last_name, e.full_name, e.username,
            e.email_corp, e.dept_id, e.role, e.ilg_state, e.manager_emp_id, e.mobile,
            e.location, e.cost_center, e.employment_type, e.hire_date, e.sync_status, e.attrs_synced_at
       FROM employees e
       LEFT JOIN local_accounts la ON la.emp_id = e.emp_id AND la.active = 1
       ${whereSql}
       ORDER BY e.full_name ASC
       LIMIT 10000`,
    params,
  );
  const headers = [
    'emp_id', 'employee_number', 'first_name', 'last_name', 'full_name', 'username',
    'email', 'department', 'designation', 'status', 'manager', 'mobile', 'location',
    'cost_center', 'employee_type', 'joining_date', 'sync_status', 'last_sync',
  ];
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push([
      r['emp_id'], r['employee_number'], r['first_name'], r['last_name'], r['full_name'], r['username'],
      r['email_corp'], r['dept_id'], r['role'], r['ilg_state'], r['manager_emp_id'], r['mobile'],
      r['location'], r['cost_center'], r['employment_type'], r['hire_date'], r['sync_status'], r['attrs_synced_at'],
    ].map((v) => JSON.stringify(v ?? '')).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="directory-users.csv"');
  res.send(lines.join('\n'));
}));

// ---------------------------------------------------------------------------
// POST /bulk-action  — enable/disable/delete/reset/assign/export/welcome
// ---------------------------------------------------------------------------
const bulkActionSchema = z.object({
  action: z.enum([
    'enable', 'disable', 'delete', 'reset_password',
    'assign_groups', 'assign_roles', 'assign_apps',
    'export', 'send_welcome',
  ]),
  empIds: z.array(z.string().min(1).max(20)).min(1).max(500),
  groupIds: z.array(z.string()).optional(),
  roleIds: z.array(z.string()).optional(),
  appIds: z.array(z.string()).optional(),
  password: z.string().min(10).optional(),
});

router.post('/bulk-action', asyncHandler(async (req: Request, res: Response) => {
  const parsed = bulkActionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }
  const adminId = (req as unknown as { user?: { empId?: string } }).user?.empId ?? 'system';
  const { action, empIds, groupIds, password } = parsed.data;
  const results: Array<{ empId: string; ok: boolean; error?: string }> = [];

  for (const empId of empIds) {
    try {
      if (action === 'enable') {
        await execute(`UPDATE employees SET ilg_state = 'ACTIVE', updated_at = UTC_TIMESTAMP() WHERE emp_id = ?`, [empId]);
      } else if (action === 'disable') {
        await execute(`UPDATE employees SET ilg_state = 'SUSPENDED_HR', updated_at = UTC_TIMESTAMP() WHERE emp_id = ?`, [empId]);
      } else if (action === 'delete') {
        await execute(`UPDATE employees SET ilg_state = 'DEPROVISIONED', updated_at = UTC_TIMESTAMP() WHERE emp_id = ?`, [empId]);
        await execute(`UPDATE local_accounts SET active = 0 WHERE emp_id = ?`, [empId]);
      } else if (action === 'reset_password') {
        const pwd = password || `Tmp!${uuidv4().replace(/-/g, '').slice(0, 10)}`;
        const policyErr = await enforcePasswordPolicy(pwd);
        if (policyErr) throw new Error(policyErr);
        const hash = await bcrypt.hash(pwd, 10);
        await execute(
          `UPDATE local_accounts SET password_hash = ? WHERE emp_id = ? AND active = 1`,
          [hash, empId],
        );
      } else if (action === 'assign_groups' && groupIds?.length) {
        for (const gid of groupIds) {
          await execute(
            `INSERT IGNORE INTO group_members (group_id, emp_id, added_by) VALUES (?, ?, ?)`,
            [gid, empId, adminId],
          );
        }
      } else if (action === 'send_welcome') {
        logger.info({ empId, adminId }, 'Bulk welcome email requested (delivery pending)');
      }
      results.push({ empId, ok: true });
    } catch (err) {
      results.push({ empId, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  await appendAuditLog(adminId, `BULK_${action.toUpperCase()}`, 'employees', {
    count: empIds.length,
    ok: results.filter((r) => r.ok).length,
  });

  res.json({
    success: results.every((r) => r.ok),
    action,
    processed: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  });
}));

// ---------------------------------------------------------------------------
// Static MFA admin routes — MUST be registered before /:empId or Express
// treats "mfa-policy" / "mfa-delivery-status" as employee IDs (404 on GET).
// ---------------------------------------------------------------------------
router.get('/mfa-policy', async (_req: Request, res: Response): Promise<void> => {
  try {
    const rows = await query<{ policy_key: string; policy_value: string }>(
      `SELECT policy_key, policy_value FROM mfa_policy`,
      [],
    );
    const policy: Record<string, unknown> = {};
    for (const r of rows) {
      try { policy[r.policy_key] = JSON.parse(r.policy_value); } catch { policy[r.policy_key] = r.policy_value; }
    }
    res.json({ data: policy });
  } catch {
    res.json({ data: {} });
  }
});

router.post('/mfa-policy', async (req: Request, res: Response): Promise<void> => {
  const adminId = (req as unknown as { user?: { empId?: string } }).user?.empId
    ?? (req as unknown as { session?: { emp_id?: string } }).session?.emp_id
    ?? 'system';
  const updates = req.body as Record<string, unknown>;
  const allowed = new Set([
    'global_enforce',
    'enforce_for_admins',
    'grace_period_hours',
    'allowed_methods',
    'excluded_group_ids',
  ]);
  for (const [key, val] of Object.entries(updates)) {
    if (!allowed.has(key)) continue;
    await execute(
      `INSERT INTO mfa_policy (policy_key, policy_value, updated_by)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE policy_value = VALUES(policy_value), updated_by = VALUES(updated_by)`,
      [key, JSON.stringify(val), String(adminId).slice(0, 20)],
    );
  }
  logger.info({ by: adminId, updates }, 'Admin updated MFA global policy');
  res.json({ success: true });
});

router.get('/mfa-delivery-status', async (_req: Request, res: Response): Promise<void> => {
  try {
    const { getMfaDeliveryConfig, publicDeliveryStatus } = await import('../services/mfa-delivery-config.js');
    const cfg = await getMfaDeliveryConfig();
    res.json({ data: publicDeliveryStatus(cfg) });
  } catch (err) {
    logger.warn({ err }, 'mfa-delivery-status failed');
    res.json({ data: { emailOtp: { ready: false, mode: 'none' }, smsOtp: { ready: false, mode: 'none' } } });
  }
});

const mfaDeliverySchema = z.object({
  emailTransport: z.enum(['smtp', 'api']).optional(),
  smtpHost:    z.string().max(255).optional(),
  smtpPort:    z.coerce.number().int().min(1).max(65535).optional(),
  smtpUser:    z.string().max(255).optional(),
  smtpPass:    z.string().max(2000).optional(),
  smtpFrom:    z.string().max(255).optional(),
  smtpSecure:  z.boolean().optional(),
  emailApiUrl: z.string().max(1000).optional(),
  emailApiKey: z.string().max(2000).optional(),
  smsApiUrl:   z.string().max(1000).optional(),
  smsApiKey:   z.string().max(2000).optional(),
  otpDevLog:   z.boolean().optional(),
  smsDevLog:   z.boolean().optional(),
  clearSmtp:   z.boolean().optional(),
  clearEmailApi: z.boolean().optional(),
  clearSms:    z.boolean().optional(),
});

function assertHttpUrl(raw: string, label: string): string | null {
  try {
    // eslint-disable-next-line no-new
    new URL(raw);
    return null;
  } catch {
    return `${label} must be a valid URL.`;
  }
}

router.put('/mfa-delivery', async (req: Request, res: Response): Promise<void> => {
  const parsed = mfaDeliverySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid payload' });
    return;
  }
  const d = parsed.data;
  const adminId = (req as unknown as { user?: { empId?: string } }).user?.empId
    ?? (req as unknown as { session?: { emp_id?: string } }).session?.emp_id
    ?? 'system';

  const { getMfaDeliveryConfig, publicDeliveryStatus } = await import('../services/mfa-delivery-config.js');
  const existing = await getMfaDeliveryConfig();

  if (d.emailTransport) {
    await execute(
      `INSERT INTO general_settings (id, email_transport, updated_by, updated_at)
       VALUES (1, ?, ?, UTC_TIMESTAMP())
       ON DUPLICATE KEY UPDATE
         email_transport = VALUES(email_transport),
         updated_by = VALUES(updated_by),
         updated_at = UTC_TIMESTAMP()`,
      [d.emailTransport, adminId],
    );
  }

  if (d.clearSmtp) {
    await execute(
      `UPDATE general_settings SET
         smtp_host = NULL, smtp_port = 587, smtp_user = NULL, smtp_pass = NULL,
         smtp_from = NULL, smtp_secure = 0, updated_by = ?, updated_at = UTC_TIMESTAMP()
       WHERE id = 1`,
      [adminId],
    );
  } else if (d.smtpHost !== undefined || d.smtpFrom !== undefined || d.smtpUser !== undefined
    || d.smtpPort !== undefined || d.smtpPass !== undefined || d.smtpSecure !== undefined) {
    const host = (d.smtpHost ?? existing.smtp.host).trim();
    const port = d.smtpPort ?? existing.smtp.port ?? 587;
    const user = (d.smtpUser ?? existing.smtp.user).trim();
    const from = (d.smtpFrom ?? existing.smtp.from).trim();
    const secure = d.smtpSecure ?? existing.smtp.secure;
    const pass = d.smtpPass !== undefined && d.smtpPass !== ''
      ? d.smtpPass
      : existing.smtp.pass;

    if (host && !from) {
      res.status(400).json({ error: 'From address is required when SMTP host is set.' });
      return;
    }

    await execute(
      `INSERT INTO general_settings
         (id, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from, smtp_secure, updated_by, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())
       ON DUPLICATE KEY UPDATE
         smtp_host = VALUES(smtp_host),
         smtp_port = VALUES(smtp_port),
         smtp_user = VALUES(smtp_user),
         smtp_pass = VALUES(smtp_pass),
         smtp_from = VALUES(smtp_from),
         smtp_secure = VALUES(smtp_secure),
         updated_by = VALUES(updated_by),
         updated_at = UTC_TIMESTAMP()`,
      [host || null, port, user || null, pass || null, from || null, secure ? 1 : 0, adminId],
    );
  }

  if (d.clearEmailApi) {
    await execute(
      `UPDATE general_settings SET
         email_api_url = NULL, email_api_key = NULL, updated_by = ?, updated_at = UTC_TIMESTAMP()
       WHERE id = 1`,
      [adminId],
    );
  } else if (d.emailApiUrl !== undefined || d.emailApiKey !== undefined) {
    const url = (d.emailApiUrl ?? existing.emailApi.apiUrl).trim();
    const key = d.emailApiKey !== undefined && d.emailApiKey !== ''
      ? d.emailApiKey
      : existing.emailApi.apiKey;
    const from = (d.smtpFrom ?? existing.smtp.from).trim();

    if (url) {
      const urlErr = assertHttpUrl(url, 'Email API URL');
      if (urlErr) {
        res.status(400).json({ error: urlErr });
        return;
      }
      if (!from) {
        res.status(400).json({ error: 'From address is required when Email API URL is set.' });
        return;
      }
    }

    await execute(
      `INSERT INTO general_settings
         (id, email_api_url, email_api_key, smtp_from, updated_by, updated_at)
       VALUES (1, ?, ?, ?, ?, UTC_TIMESTAMP())
       ON DUPLICATE KEY UPDATE
         email_api_url = VALUES(email_api_url),
         email_api_key = VALUES(email_api_key),
         smtp_from = VALUES(smtp_from),
         updated_by = VALUES(updated_by),
         updated_at = UTC_TIMESTAMP()`,
      [url || null, key || null, from || null, adminId],
    );
  }

  if (d.clearSms) {
    await execute(
      `UPDATE general_settings SET
         sms_api_url = NULL, sms_api_key = NULL, updated_by = ?, updated_at = UTC_TIMESTAMP()
       WHERE id = 1`,
      [adminId],
    );
  } else if (d.smsApiUrl !== undefined || d.smsApiKey !== undefined) {
    const url = (d.smsApiUrl ?? existing.sms.apiUrl).trim();
    const key = d.smsApiKey !== undefined && d.smsApiKey !== ''
      ? d.smsApiKey
      : existing.sms.apiKey;

    if (url) {
      const urlErr = assertHttpUrl(url, 'SMS API URL');
      if (urlErr) {
        res.status(400).json({ error: urlErr });
        return;
      }
    }

    await execute(
      `INSERT INTO general_settings
         (id, sms_api_url, sms_api_key, updated_by, updated_at)
       VALUES (1, ?, ?, ?, UTC_TIMESTAMP())
       ON DUPLICATE KEY UPDATE
         sms_api_url = VALUES(sms_api_url),
         sms_api_key = VALUES(sms_api_key),
         updated_by = VALUES(updated_by),
         updated_at = UTC_TIMESTAMP()`,
      [url || null, key || null, adminId],
    );
  }

  if (d.otpDevLog !== undefined || d.smsDevLog !== undefined) {
    const otpDev = d.otpDevLog !== undefined ? (d.otpDevLog ? 1 : 0) : (existing.otpDevLog ? 1 : 0);
    const smsDev = d.smsDevLog !== undefined ? (d.smsDevLog ? 1 : 0) : (existing.smsDevLog ? 1 : 0);
    await execute(
      `INSERT INTO general_settings (id, mfa_otp_dev_log, sms_dev_log, updated_by, updated_at)
       VALUES (1, ?, ?, ?, UTC_TIMESTAMP())
       ON DUPLICATE KEY UPDATE
         mfa_otp_dev_log = VALUES(mfa_otp_dev_log),
         sms_dev_log = VALUES(sms_dev_log),
         updated_by = VALUES(updated_by),
         updated_at = UTC_TIMESTAMP()`,
      [otpDev, smsDev, adminId],
    );
  }

  logger.info({ by: adminId }, 'Admin updated MFA delivery settings');
  const cfg = await getMfaDeliveryConfig();
  res.json({ success: true, data: publicDeliveryStatus(cfg) });
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
            CASE WHEN la.role IN ('ADMIN','SUPER_ADMIN','APP_CONTRIBUTOR','USER_GROUP_MANAGER','CUSTOM') THEN la.role ELSE NULL END AS portal_role,
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
                  CASE WHEN la.role IN ('ADMIN','SUPER_ADMIN','APP_CONTRIBUTOR','USER_GROUP_MANAGER','CUSTOM') THEN la.role ELSE NULL END AS portal_role,
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
      `SELECT session_id, iss, ip, user_agent, device_info, geo_location,
              created_at AS started_at, last_active_at
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
    policyExcludedByGroup: false,
  };
  try {
    const [status, policyExcludedByGroup] = await Promise.all([
      getMfaStatus(profileEmpId),
      isUserExcludedFromPolicyMfa(profileEmpId),
    ]);
    mfaStatus = {
      ...(status as unknown as Record<string, unknown>),
      policyExcludedByGroup,
    };
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
  const [status, policyExcludedByGroup] = await Promise.all([
    getMfaStatus(emp.emp_id),
    isUserExcludedFromPolicyMfa(emp.emp_id),
  ]);
  res.json({ ...status, policyExcludedByGroup });
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
// POST /:empId/mfa/enforce  — set or clear MFA enforcement for one user
// ---------------------------------------------------------------------------
router.post('/:empId/mfa/enforce', async (req: Request, res: Response): Promise<void> => {
  const { empId } = req.params;
  const enforce: boolean = req.body?.enforce !== false;
  const emp = await queryOne<{ emp_id: string }>(
    `SELECT emp_id FROM employees WHERE emp_id = ?`,
    [empId],
  );
  if (!emp) { res.status(404).json({ error: 'Employee not found' }); return; }

  const adminId = (req as unknown as { session?: { emp_id?: string } }).session?.emp_id ?? 'system';
  if (enforce) {
    await query(
      `UPDATE employees SET mfa_enforced = 1, mfa_enforced_at = NOW(), mfa_enforced_by = ? WHERE emp_id = ?`,
      [adminId, emp.emp_id],
    );
  } else {
    await query(
      `UPDATE employees SET mfa_enforced = 0, mfa_enforced_at = NULL, mfa_enforced_by = NULL WHERE emp_id = ?`,
      [emp.emp_id],
    );
  }
  logger.info({ empId: emp.emp_id, enforce, by: adminId }, 'Admin set MFA enforcement for user');
  res.json({ success: true, mfa_enforced: enforce });
});

// ---------------------------------------------------------------------------
// POST /local  — create a brand-new local employee + local account
// ---------------------------------------------------------------------------
const createLocalSchema = z.object({
  employeeId:     z.string().min(1).max(20).optional(),
  username:       z.string().min(1).max(100).optional(),
  firstName:      z.string().min(1).max(100).optional(),
  lastName:       z.string().min(1).max(100).optional(),
  displayName:    z.string().max(200).optional(),
  email:          z.string().email(),
  department:     z.string().max(100).optional(),
  designation:    z.string().max(200).optional(),
  managerId:      z.string().max(20).optional(),
  mobile:         z.string().max(40).optional(),
  location:       z.string().max(200).optional(),
  country:        z.string().max(80).optional(),
  costCenter:     z.string().max(80).optional(),
  empType:        z.enum(['CORPORATE', 'STORE', 'PLANT', 'DC']).default('CORPORATE'),
  joiningDate:    z.string().max(32).optional(),
  status:         z.enum(['ACTIVE', 'SUSPENDED_HR', 'INACTIVE']).default('ACTIVE'),
  // Legacy aliases
  fullName:       z.string().min(2).max(200).optional(),
  password:       z.string().min(10).optional(),
  generatePassword: z.boolean().optional(),
  sendWelcomeEmail: z.boolean().optional(),
  portalRole:     z.enum(['USER', 'MANAGER', 'HRBP', 'ADMIN', 'SUPER_ADMIN']).default('USER'),
  role:           z.enum(['USER', 'MANAGER', 'HRBP', 'ADMIN', 'SUPER_ADMIN']).optional(),
  deptId:         z.string().max(50).optional(),
  groupIds:       z.array(z.string()).optional(),
  businessRoleIds: z.array(z.string()).optional(),
  appIds:         z.array(z.string()).optional(),
}).refine((d) => !!(d.fullName || (d.firstName && d.lastName) || d.displayName), {
  message: 'Name is required',
});

router.post('/local', async (req: Request, res: Response): Promise<void> => {
  const parsed = createLocalSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }
  const d = parsed.data;
  const portalRole = d.portalRole || d.role || 'USER';

  if (portalRole === 'SUPER_ADMIN' && req.user?.role !== 'SUPER_ADMIN') {
    res.status(403).json({ error: 'Only Super Admins can create Super Admin accounts', code: 'INSUFFICIENT_ROLE' });
    return;
  }

  const password = d.generatePassword || !d.password
    ? `Lk!${crypto.randomBytes(9).toString('base64url').slice(0, 12)}`
    : d.password;

  const policyErr = await enforcePasswordPolicy(password);
  if (policyErr) {
    res.status(400).json({ error: policyErr, code: 'PASSWORD_POLICY' });
    return;
  }

  const firstName = d.firstName || (d.fullName || d.displayName || '').trim().split(/\s+/)[0] || 'User';
  const lastName = d.lastName || (d.fullName || d.displayName || '').trim().split(/\s+/).slice(1).join(' ') || '';
  const fullName = d.displayName?.trim() || d.fullName?.trim() || `${firstName} ${lastName}`.trim();
  const empId = d.employeeId || `LOC-${uuidv4().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
  const username = d.username || d.email.split('@')[0] || empId;

  const existing = await queryOne<{ c: number }>(
    `SELECT COUNT(*) AS c FROM employees WHERE email_corp = ? OR emp_id = ? OR employee_number = ?`,
    [d.email, empId, empId],
  );
  if ((existing?.c ?? 0) > 0) {
    res.status(409).json({ error: 'An employee with this email or Employee ID already exists' });
    return;
  }

  if (d.managerId) {
    const mgr = await queryOne<{ emp_id: string }>(`SELECT emp_id FROM employees WHERE emp_id = ?`, [d.managerId]);
    if (!mgr) {
      res.status(400).json({ error: 'Manager not found', code: 'INVALID_MANAGER' });
      return;
    }
  }

  const hash = await bcrypt.hash(password, 10);
  const adminId = (req as unknown as { user?: { empId?: string } }).user?.empId ?? 'system';
  const ilgState = d.status === 'INACTIVE' ? 'SUSPENDED_HR' : d.status;
  const department = d.department || d.deptId || null;

  await execute(
    `INSERT INTO employees
       (emp_id, employee_number, full_name, first_name, last_name, username, email_corp,
        role, employment_type, dept_id, manager_emp_id, mobile, location, country, cost_center,
        ilg_state, hrms_status, hire_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', COALESCE(?, UTC_DATE()))`,
    [
      empId, empId, fullName, firstName, lastName || null, username, d.email,
      d.designation ?? null, d.empType, department, d.managerId ?? null,
      d.mobile ?? null, d.location ?? null, d.country ?? null, d.costCenter ?? null,
      ilgState, d.joiningDate ?? null,
    ],
  );

  await execute(
    `INSERT INTO local_accounts (emp_id, email, password_hash, role, created_by, active)
     VALUES (?, ?, ?, ?, ?, 1)`,
    [empId, d.email, hash, portalRole, adminId],
  );

  if (d.groupIds?.length) {
    for (const gid of d.groupIds) {
      await execute(
        `INSERT IGNORE INTO group_members (group_id, emp_id, added_by) VALUES (?, ?, ?)`,
        [gid, empId, adminId],
      );
    }
  }

  await writeDirectoryUserAudit({
    empId,
    action: 'USER_CREATED',
    adminEmpId: adminId,
    source: 'LOCAL',
    newValues: { email: d.email, username, department },
  });
  await appendAuditLog(adminId, 'USER_CREATED', empId, { email: d.email, source: 'LOCAL' });

  if (d.sendWelcomeEmail) {
    logger.info({ empId, email: d.email }, 'Welcome email requested (delivery pending)');
  }

  logger.info({ empId, email: d.email, createdBy: adminId }, 'Local user created');
  res.status(201).json({
    empId,
    email: d.email,
    username,
    generatedPassword: d.generatePassword || !d.password ? password : undefined,
  });
});

// ---------------------------------------------------------------------------
// POST /:empId/reset-password  — admin reset + multi-source writeback
// ---------------------------------------------------------------------------
const resetPwdSchema = z.object({
  newPassword:  z.string().min(10),
  notifyUser:   z.boolean().default(false),
});

router.post('/:empId/reset-password', asyncHandler(async (req: Request, res: Response) => {
  const { empId: requestedEmpId } = req.params;
  const parsed = resetPwdSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }
  const { newPassword, notifyUser } = parsed.data;
  const adminId = (req as unknown as { user?: { empId?: string } }).user?.empId ?? 'admin';

  const policyErr = await enforcePasswordPolicy(newPassword);
  if (policyErr) {
    res.status(400).json({ error: policyErr, code: 'PASSWORD_POLICY' });
    return;
  }

  const employee = await queryOne<{ emp_id: string; email_corp: string; role: string | null }>(
    `SELECT emp_id, email_corp, role FROM employees WHERE emp_id = ?`,
    [requestedEmpId],
  );
  if (!employee) {
    res.status(404).json({ error: 'Employee not found' });
    return;
  }

  const empId = await ensureWritebackIdentityLinks(requestedEmpId);

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
      const existingPortal = await queryOne<{ role: string }>(
        `SELECT role FROM local_accounts WHERE emp_id = ? AND active = 1`,
        [empId],
      );
      const localRole = existingPortal?.role ?? 'USER';
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
// PATCH /:empId/role  — assign or revoke portal administrator access
// ---------------------------------------------------------------------------
const patchRoleSchema = z.object({
  /** USER = revoke; otherwise portal role id or system key (ADMIN, APP_CONTRIBUTOR, custom uuid, …) */
  role: z.string().min(1),
});

router.patch('/:empId/role', requireRole('SUPER_ADMIN'), asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { empId } = req.params;
  const parsed = patchRoleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid role', details: parsed.error.flatten() });
    return;
  }
  const { role } = parsed.data;
  const adminId = req.user!.empId;

  const emp = await queryOne<{ emp_id: string }>(
    `SELECT emp_id FROM employees WHERE emp_id = ?`, [empId],
  );
  if (!emp) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  if (role === 'USER' || role === 'NONE' || role === 'REVOKE') {
    await revokePortalRole(empId);
    logger.info({ empId, role: null, adminId }, 'Portal administrator role revoked');
    res.json({ success: true, empId, portalRole: null });
    return;
  }

  try {
    const assigned = await assignPortalRole(empId, role, adminId);
    logger.info({ empId, role: assigned.roleKey, roleId: assigned.roleId, adminId }, 'Portal administrator role updated');
    res.json({ success: true, empId, portalRole: assigned.roleKey, portalRoleId: assigned.roleId });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Assign failed' });
  }
}));

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
