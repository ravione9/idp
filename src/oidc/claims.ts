/**
 * OIDC claims from the employee directory.
 */
import { queryOne } from '../db/connection.js';

export interface UserClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  given_name?: string;
  family_name?: string;
  emp_id?: string;
  role?: string;
}

export async function loadUserClaims(empId: string, scopes: string[]): Promise<UserClaims | null> {
  const emp = await queryOne<{
    emp_id: string;
    full_name: string;
    email_corp: string;
    role: string | null;
    ilg_state: string;
  }>(
    `SELECT emp_id, full_name, email_corp, role, ilg_state
       FROM employees
      WHERE emp_id = ?`,
    [empId],
  );
  if (!emp) return null;
  if (!['ACTIVE', 'REACTIVATED'].includes(emp.ilg_state)) return null;

  const scopeSet = new Set(scopes);
  const claims: UserClaims = { sub: emp.emp_id };

  if (scopeSet.has('openid') || scopeSet.has('profile') || scopeSet.has('email')) {
    claims.emp_id = emp.emp_id;
  }
  if (scopeSet.has('email')) {
    claims.email = emp.email_corp;
    claims.email_verified = true;
  }
  if (scopeSet.has('profile')) {
    claims.name = emp.full_name;
    claims.preferred_username = emp.email_corp.split('@')[0] ?? emp.emp_id;
    const parts = emp.full_name.trim().split(/\s+/);
    if (parts[0]) claims.given_name = parts[0];
    if (parts.length > 1) claims.family_name = parts.slice(1).join(' ');
    if (emp.role) claims.role = emp.role;
  }

  return claims;
}
