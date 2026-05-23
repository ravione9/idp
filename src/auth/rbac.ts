/**
 * LILG RBAC Middleware
 * --------------------
 * Role hierarchy and scope-aware access control.
 */

import { Request, Response, NextFunction } from 'express';

// ---------------------------------------------------------------------------
// Role hierarchy (higher index = broader authority)
// ---------------------------------------------------------------------------
export const ROLES = ['EMPLOYEE', 'MANAGER', 'HRBP', 'ADMIN', 'SUPER_ADMIN'] as const;
export type Role = (typeof ROLES)[number];

const ROLE_INDEX: Record<string, number> = Object.fromEntries(
  ROLES.map((r, i) => [r, i]),
);

/**
 * Returns true if `userRole` has at least the privilege of `requiredRole`.
 */
export function roleAtLeast(userRole: string, requiredRole: Role): boolean {
  const userIdx = ROLE_INDEX[userRole] ?? -1;
  const reqIdx  = ROLE_INDEX[requiredRole] ?? 999;
  return userIdx >= reqIdx;
}

// ---------------------------------------------------------------------------
// requireRole middleware factory
// ---------------------------------------------------------------------------
/**
 * Middleware that enforces that the authenticated user holds one of the
 * listed roles (or a role with higher authority in the hierarchy).
 *
 * Usage:
 *   router.post('/action', requireAuth, requireRole('MANAGER', 'ADMIN'), handler)
 */
export function requireRole(...allowedRoles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }

    // Check if the user's role satisfies at least one of the allowed roles
    const hasRole = allowedRoles.some((allowed) => roleAtLeast(user.role, allowed));
    if (!hasRole) {
      res.status(403).json({
        error:    'Forbidden',
        code:     'INSUFFICIENT_ROLE',
        required: allowedRoles,
        got:      user.role,
      });
      return;
    }

    next();
  };
}

// ---------------------------------------------------------------------------
// Scope helpers — returns a SQL fragment + bind params for scoping queries
// ---------------------------------------------------------------------------
export interface ScopeClause {
  /** SQL WHERE fragment with ? placeholders */
  sql:    string;
  /** Positional values corresponding to the placeholders */
  params: unknown[];
}

/**
 * Build a SQL scope clause based on the authenticated user's role.
 *
 * - EMPLOYEE:   can only see themselves
 * - MANAGER:    can see direct reports (manager_emp_id = user's emp_id)
 * - HRBP:       can see employees in their state/region (hrbp_emp_id column if present)
 * - ADMIN:      can see all employees (1=1)
 * - SUPER_ADMIN: can see all employees (1=1)
 */
export function getEmployeeScope(req: Request): ScopeClause {
  const user = req.user;
  if (!user) {
    // Deny-all fallback
    return { sql: '1=0', params: [] };
  }

  const role = user.role as Role;

  if (roleAtLeast(role, 'ADMIN')) {
    return { sql: '1=1', params: [] };
  }

  if (role === 'HRBP') {
    // HRBP sees employees in their city/state scope
    // Assumes a hrbp_emp_id column or that HRBP is scoped by state
    return {
      sql:    '(e.state = (SELECT state FROM employees WHERE emp_id = ?) OR e.manager_emp_id = ?)',
      params: [user.empId, user.empId],
    };
  }

  if (role === 'MANAGER') {
    return {
      sql:    'e.manager_emp_id = ?',
      params: [user.empId],
    };
  }

  // Default: EMPLOYEE can only access their own record
  return { sql: 'e.emp_id = ?', params: [user.empId] };
}
