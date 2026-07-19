/**
 * Local administrator accounts (email + password, stored in MySQL)
 */

import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { query, queryOne, transaction } from '../db/connection.js';
import logger from '../utils/logger.js';
import type { Role } from '../auth/rbac.js';
import {
  PORTAL_OPERATOR_ROLES,
  SYSTEM_KEY_TO_ID,
  sessionRoleForPortalRole,
} from './portal-roles.js';

const BCRYPT_ROUNDS = 12;

/** Portal console role stored in local_accounts — separate from employees.role (job designation). */
export async function getPortalRole(empId: string): Promise<Role | null> {
  const row = await queryOne<{ role: string }>(
    `SELECT role FROM local_accounts
      WHERE emp_id = ? AND active = 1`,
    [empId],
  );
  return row && PORTAL_OPERATOR_ROLES.has(row.role) ? (row.role as Role) : null;
}

/** Assign a built-in or custom portal role by portal_roles.id or system role_key. */
export async function assignPortalRole(
  empId: string,
  roleOrId: string,
  createdBy: string,
): Promise<{ roleKey: string; roleId: string }> {
  const emp = await queryOne<{ email_corp: string | null }>(
    'SELECT email_corp FROM employees WHERE emp_id = ?',
    [empId],
  );
  if (!emp?.email_corp) {
    throw new Error('Employee not found or has no corporate email');
  }

  const roleRow = await queryOne<{ id: string; role_key: string; active: number }>(
    `SELECT id, role_key, active FROM portal_roles
      WHERE (id = ? OR role_key = ?) AND active = 1`,
    [roleOrId, roleOrId],
  );
  if (!roleRow) {
    // Legacy shortcut: ADMIN / SUPER_ADMIN before migration seed
    const legacyId = SYSTEM_KEY_TO_ID[roleOrId];
    if (!legacyId) throw new Error('Unknown portal role');
    return assignPortalRole(empId, legacyId, createdBy);
  }

  const sessionRole = sessionRoleForPortalRole(roleRow.role_key);
  const email = emp.email_corp.toLowerCase().trim();
  const existing = await queryOne<{ id: number }>(
    'SELECT id FROM local_accounts WHERE emp_id = ?',
    [empId],
  );

  if (existing) {
    await query(
      `UPDATE local_accounts SET role = ?, portal_role_id = ?, active = 1 WHERE emp_id = ?`,
      [sessionRole, roleRow.id, empId],
    );
  } else {
    const passwordHash = await hashPassword(`${uuidv4()}${uuidv4()}`);
    await query(
      `INSERT INTO local_accounts (emp_id, email, password_hash, role, portal_role_id, created_by, active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [empId, email, passwordHash, sessionRole, roleRow.id, createdBy],
    );
  }
  return { roleKey: roleRow.role_key, roleId: roleRow.id };
}

export async function revokePortalRole(empId: string): Promise<void> {
  await query(
    `UPDATE local_accounts SET role = 'USER', portal_role_id = NULL
      WHERE emp_id = ? AND active = 1`,
    [empId],
  );
}

export interface LocalAccountRow {
  id:           number;
  emp_id:       string;
  email:        string;
  full_name:    string;
  role:         string;
  portal_role_id: string | null;
  role_name:    string | null;
  active:       number;
  created_at:   string;
  last_login_at: string | null;
  has_local_account: number;
}

export async function countLocalAdmins(): Promise<number> {
  const row = await queryOne<{ n: number }>(
    'SELECT COUNT(*) AS n FROM local_accounts WHERE active = 1',
    [],
  );
  return row?.n ?? 0;
}

export async function findLocalAccountByEmail(email: string): Promise<{
  id: number;
  emp_id: string;
  email: string;
  password_hash: string;
  role: string;
  active: number;
  ilg_state: string;
  hrms_status: string;
} | null> {
  return queryOne(
    `SELECT la.id, la.emp_id, la.email, la.password_hash, la.role, la.active,
            e.ilg_state, e.hrms_status
       FROM local_accounts la
       JOIN employees e ON e.emp_id = la.emp_id
      WHERE la.email = ? AND la.active = 1`,
    [email.toLowerCase().trim()],
  );
}

export async function verifyLocalPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function touchLocalLogin(accountId: number): Promise<void> {
  await query(
    'UPDATE local_accounts SET last_login_at = UTC_TIMESTAMP() WHERE id = ?',
    [accountId],
  );
}

export async function listLocalAdmins(): Promise<LocalAccountRow[]> {
  return query<LocalAccountRow>(
    `SELECT la.id, la.emp_id, e.full_name, la.email, la.role, la.portal_role_id,
            COALESCE(pr.name, la.role) AS role_name,
            la.active, la.created_at, la.last_login_at,
            IF(e.emp_id LIKE 'LOC%', 1, 0) AS has_local_account
       FROM local_accounts la
       JOIN employees e ON e.emp_id = la.emp_id
       LEFT JOIN portal_roles pr ON pr.id = la.portal_role_id
      WHERE la.active = 1
        AND (la.role IN ('ADMIN','SUPER_ADMIN','APP_CONTRIBUTOR','USER_GROUP_MANAGER','CUSTOM')
             OR la.portal_role_id IS NOT NULL)
      ORDER BY la.created_at DESC`,
    [],
  );
}

function nextLocalEmpId(): string {
  return `LOC${uuidv4().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

export async function createLocalAdministrator(params: {
  fullName:   string;
  email:      string;
  password:   string;
  role:       string; // portal role id or system key
  createdBy:  string;
}): Promise<{ empId: string; email: string; role: string; roleId: string }> {
  const roleRow = await queryOne<{ id: string; role_key: string }>(
    `SELECT id, role_key FROM portal_roles WHERE (id = ? OR role_key = ?) AND active = 1`,
    [params.role, params.role],
  );
  if (!roleRow) {
    throw new Error('Unknown portal role');
  }
  const sessionRole = sessionRoleForPortalRole(roleRow.role_key);

  const email = params.email.toLowerCase().trim();
  const existing = await queryOne<{ id: number }>(
    'SELECT id FROM local_accounts WHERE email = ?',
    [email],
  );
  if (existing) {
    throw new Error('A local account with this email already exists');
  }

  const empId = nextLocalEmpId();
  const passwordHash = await hashPassword(params.password);

  await transaction(async (conn) => {
    await conn.execute(
      `INSERT INTO employees
         (emp_id, full_name, email_corp, hire_date, employment_type, hrms_status, ilg_state)
       VALUES (?, ?, ?, CURDATE(), 'CORPORATE', 'ACTIVE', 'ACTIVE')`,
      [empId, params.fullName, email],
    );

    await conn.execute(
      `INSERT INTO local_accounts (emp_id, email, password_hash, role, portal_role_id, created_by, active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [empId, email, passwordHash, sessionRole, roleRow.id, params.createdBy],
    );
  });

  return { empId, email, role: sessionRole, roleId: roleRow.id };
}

export function isMasterAdminCredentials(email: string, password: string): boolean {
  const master = config.app.masterAdmin;
  if (!master) return false;
  return email.toLowerCase().trim() === master.email && password === master.password;
}

/** Create or sync password for the env-configured master SUPER_ADMIN on every startup. */
export async function ensureMasterAdminFromEnv(): Promise<void> {
  const master = config.app.masterAdmin;
  if (!master) return;

  const existing = await queryOne<{ id: number; password_hash: string; emp_id: string }>(
    'SELECT id, password_hash, emp_id FROM local_accounts WHERE email = ?',
    [master.email],
  );

  if (!existing) {
    await createLocalAdministrator({
      fullName:  master.fullName,
      email:     master.email,
      password:  master.password,
      role:      'SUPER_ADMIN',
      createdBy: 'ENV',
    });
    logger.info({ email: master.email }, 'Master admin created from env');
    return;
  }

  const passwordMatches = await verifyLocalPassword(master.password, existing.password_hash);
  if (!passwordMatches) {
    const passwordHash = await hashPassword(master.password);
    await query(
      `UPDATE local_accounts
          SET password_hash = ?, role = 'SUPER_ADMIN', portal_role_id = 'pr-super-admin', active = 1
        WHERE id = ?`,
      [passwordHash, existing.id],
    );
    logger.info({ email: master.email }, 'Master admin password synced from env');
  } else {
    await query(
      `UPDATE local_accounts SET role = 'SUPER_ADMIN', portal_role_id = 'pr-super-admin', active = 1 WHERE id = ?`,
      [existing.id],
    );
  }

  await query(
    `UPDATE employees
        SET full_name = ?, hrms_status = 'ACTIVE', ilg_state = 'ACTIVE'
      WHERE emp_id = ?`,
    [master.fullName, existing.emp_id],
  );
}

export async function deactivateLocalAdmin(accountId: number, actorEmpId: string): Promise<void> {
  const account = await queryOne<{ emp_id: string }>(
    'SELECT emp_id FROM local_accounts WHERE id = ?',
    [accountId],
  );
  if (!account) {
    throw new Error('Local account not found');
  }
  if (account.emp_id === actorEmpId) {
    throw new Error('You cannot deactivate your own account');
  }

  await query('UPDATE local_accounts SET active = 0 WHERE id = ?', [accountId]);
}
