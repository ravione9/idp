/**
 * Local administrator accounts (email + password, stored in MySQL)
 */

import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne, transaction } from '../db/connection.js';
import type { Role } from '../auth/rbac.js';

const BCRYPT_ROUNDS = 12;
const ADMIN_ROLES: Role[] = ['ADMIN', 'SUPER_ADMIN'];

export interface LocalAccountRow {
  id:           number;
  emp_id:       string;
  email:        string;
  role:         string;
  active:       number;
  created_at:   string;
  last_login_at: string | null;
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
    `SELECT la.id, la.emp_id, la.email, la.role, la.active, la.created_at, la.last_login_at
       FROM local_accounts la
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
  role:       Role;
  createdBy:  string;
}): Promise<{ empId: string; email: string; role: string }> {
  if (!ADMIN_ROLES.includes(params.role)) {
    throw new Error('Role must be ADMIN or SUPER_ADMIN');
  }

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
         (emp_id, full_name, email_corp, hire_date, employment_type, hrms_status, ilg_state, role)
       VALUES (?, ?, ?, CURDATE(), 'CORPORATE', 'ACTIVE', 'ACTIVE', ?)`,
      [empId, params.fullName, email, params.role],
    );

    await conn.execute(
      `INSERT INTO local_accounts (emp_id, email, password_hash, role, created_by, active)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [empId, email, passwordHash, params.role, params.createdBy],
    );
  });

  return { empId, email, role: params.role };
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
