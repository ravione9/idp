/**
 * Portal console roles — built-in + custom — with per-module read/write.
 * Privileged Access (PAM) is SUPER_ADMIN-gated in the API/UI (not a portal module ACL).
 */

import { v4 as uuidv4 } from 'uuid';
import { query, queryOne, execute } from '../db/connection.js';

export const PORTAL_MODULES = [
  { key: 'overview',         label: 'Overview',            group: 'Overview' },
  { key: 'identity_users',   label: 'Users / Identities',  group: 'Identity' },
  { key: 'identity_groups',  label: 'Groups',              group: 'Identity' },
  { key: 'applications',     label: 'Applications',        group: 'Applications' },
  { key: 'authentication',   label: 'Authentication',      group: 'Authentication' },
  { key: 'connections',      label: 'Directory Sync',      group: 'Connections' },
  { key: 'access_model',     label: 'Access Model',        group: 'Access Model' },
  { key: 'governance',       label: 'Identity Governance', group: 'Identity Governance' },
  { key: 'workflows',        label: 'Workflows',           group: 'Workflows' },
  { key: 'reports',          label: 'Reports',             group: 'Reports' },
  { key: 'settings',         label: 'Settings',            group: 'Settings' },
  { key: 'administrators',   label: 'Administrators',      group: 'Identity' },
] as const;

export type PortalModuleKey = (typeof PORTAL_MODULES)[number]['key'];

export const ROUTE_MODULE: Record<string, PortalModuleKey> = {
  dashboard: 'overview',
  users: 'identity_users',
  bulkUsers: 'identity_users',
  identityProfiles: 'identity_users',
  groups: 'identity_groups',
  admins: 'administrators',
  applications: 'applications',
  ssoConfig: 'authentication',
  mfaMethods: 'authentication',
  adaptiveAuth: 'authentication',
  passwordPolicies: 'authentication',
  radiusVpn: 'authentication',
  directorySync: 'connections',
  roles: 'access_model',
  birthright: 'access_model',
  appAccessPolicy: 'access_model',
  reviews: 'governance',
  sod: 'governance',
  risk: 'governance',
  attendanceIga: 'governance',
  workflowLibrary: 'workflows',
  notifications: 'workflows',
  audit: 'reports',
  reports: 'reports',
  generalSettings: 'settings',
  branding: 'settings',
  tickets: 'settings',
  systemHealth: 'settings',
  license: 'administrators',
};

/** Roles that may operate the admin console (session role column). */
export const PORTAL_OPERATOR_ROLES = new Set([
  'ADMIN', 'SUPER_ADMIN', 'APP_CONTRIBUTOR', 'USER_GROUP_MANAGER', 'CUSTOM',
]);

export interface ModulePerm { read: boolean; write: boolean }

export interface PortalAccess {
  roleId: string;
  roleKey: string;
  roleName: string;
  isSystem: boolean;
  modules: Record<string, ModulePerm>;
}

const SYSTEM_KEY_TO_ID: Record<string, string> = {
  SUPER_ADMIN: 'pr-super-admin',
  ADMIN: 'pr-admin',
  APP_CONTRIBUTOR: 'pr-app-contributor',
  USER_GROUP_MANAGER: 'pr-user-group-mgr',
};

export async function listPortalRoles(includeInactive = false) {
  const rows = await query<{
    id: string; role_key: string; name: string; description: string | null;
    is_system: number; active: number; created_at: string;
  }>(
    `SELECT id, role_key, name, description, is_system, active, created_at
       FROM portal_roles
      WHERE ${includeInactive ? '1=1' : 'active = 1'}
      ORDER BY is_system DESC, name ASC`,
    [],
  );
  return rows;
}

export async function getRolePermissions(roleId: string): Promise<Record<string, ModulePerm>> {
  const rows = await query<{ module_key: string; can_read: number; can_write: number }>(
    `SELECT module_key, can_read, can_write FROM portal_role_permissions WHERE role_id = ?`,
    [roleId],
  );
  const out: Record<string, ModulePerm> = {};
  for (const r of rows) {
    out[r.module_key] = { read: !!r.can_read, write: !!r.can_write };
  }
  return out;
}

export async function resolvePortalAccess(empId: string, sessionRole?: string): Promise<PortalAccess | null> {
  const acct = await queryOne<{ role: string; portal_role_id: string | null }>(
    `SELECT role, portal_role_id FROM local_accounts WHERE emp_id = ? AND active = 1`,
    [empId],
  );
  if (!acct) return null;

  let roleId = acct.portal_role_id;
  if (!roleId) {
    roleId = SYSTEM_KEY_TO_ID[acct.role] ?? null;
  }
  if (!roleId && sessionRole && SYSTEM_KEY_TO_ID[sessionRole]) {
    roleId = SYSTEM_KEY_TO_ID[sessionRole];
  }
  if (!roleId) {
    if (!PORTAL_OPERATOR_ROLES.has(acct.role)) return null;
    return null;
  }

  const role = await queryOne<{
    id: string; role_key: string; name: string; is_system: number; active: number;
  }>(
    `SELECT id, role_key, name, is_system, active FROM portal_roles WHERE id = ?`,
    [roleId],
  );
  if (!role || !role.active) return null;

  const modules = await getRolePermissions(role.id);
  return {
    roleId: role.id,
    roleKey: role.role_key,
    roleName: role.name,
    isSystem: !!role.is_system,
    modules,
  };
}

export function hasModuleAccess(
  access: PortalAccess | null | undefined,
  moduleKey: string,
  level: 'read' | 'write',
): boolean {
  if (!access) return false;
  if (access.roleKey === 'SUPER_ADMIN') return true;
  const perm = access.modules[moduleKey];
  if (!perm) return false;
  return level === 'write' ? !!perm.write : !!(perm.read || perm.write);
}

export async function createCustomRole(input: {
  name: string;
  description?: string;
  permissions: Array<{ moduleKey: string; canRead: boolean; canWrite: boolean }>;
  createdBy?: string;
}): Promise<string> {
  const id = uuidv4();
  const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48)
    || 'custom';
  const roleKey = `custom_${slug}_${id.slice(0, 8)}`;

  await execute(
    `INSERT INTO portal_roles (id, role_key, name, description, is_system, active, created_by)
     VALUES (?, ?, ?, ?, 0, 1, ?)`,
    [id, roleKey, input.name.trim(), input.description?.trim() || null, input.createdBy ?? null],
  );

  await replacePermissions(id, input.permissions);
  return id;
}

export async function updateCustomRole(
  roleId: string,
  input: {
    name?: string;
    description?: string;
    active?: boolean;
    permissions?: Array<{ moduleKey: string; canRead: boolean; canWrite: boolean }>;
  },
): Promise<void> {
  const role = await queryOne<{ is_system: number }>(
    `SELECT is_system FROM portal_roles WHERE id = ?`,
    [roleId],
  );
  if (!role) throw new Error('Role not found');
  if (role.is_system) throw new Error('System roles cannot be edited here — clone as custom instead');

  if (input.name != null || input.description !== undefined || input.active !== undefined) {
    await execute(
      `UPDATE portal_roles SET
         name = COALESCE(?, name),
         description = COALESCE(?, description),
         active = COALESCE(?, active),
         updated_at = UTC_TIMESTAMP()
       WHERE id = ?`,
      [
        input.name?.trim() ?? null,
        input.description !== undefined ? (input.description?.trim() || null) : null,
        input.active === undefined ? null : (input.active ? 1 : 0),
        roleId,
      ],
    );
  }
  if (input.permissions) {
    await replacePermissions(roleId, input.permissions);
  }
}

export async function deleteCustomRole(roleId: string): Promise<void> {
  const role = await queryOne<{ is_system: number }>(
    `SELECT is_system FROM portal_roles WHERE id = ?`,
    [roleId],
  );
  if (!role) throw new Error('Role not found');
  if (role.is_system) throw new Error('System roles cannot be deleted');

  const inUse = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM local_accounts WHERE portal_role_id = ? AND active = 1`,
    [roleId],
  );
  if ((inUse?.n ?? 0) > 0) {
    throw new Error('Role is assigned to administrators — reassign them first');
  }
  await execute(`DELETE FROM portal_roles WHERE id = ?`, [roleId]);
}

async function replacePermissions(
  roleId: string,
  permissions: Array<{ moduleKey: string; canRead: boolean; canWrite: boolean }>,
): Promise<void> {
  const valid = new Set(PORTAL_MODULES.map((m) => m.key));
  await execute(`DELETE FROM portal_role_permissions WHERE role_id = ?`, [roleId]);
  for (const p of permissions) {
    if (!valid.has(p.moduleKey as PortalModuleKey)) continue;
    if (p.moduleKey === 'administrators' && !(p.canRead || p.canWrite)) continue;
    // Never expose a PAM module key even if sent
    if (p.moduleKey === 'pam' || String(p.moduleKey).startsWith('pam')) continue;
    const canWrite = p.canWrite ? 1 : 0;
    const canRead = (p.canRead || p.canWrite) ? 1 : 0;
    if (!canRead && !canWrite) continue;
    await execute(
      `INSERT INTO portal_role_permissions (role_id, module_key, can_read, can_write)
       VALUES (?, ?, ?, ?)`,
      [roleId, p.moduleKey, canRead, canWrite],
    );
  }
}

export function sessionRoleForPortalRole(roleKey: string): string {
  if (roleKey === 'SUPER_ADMIN' || roleKey === 'ADMIN'
    || roleKey === 'APP_CONTRIBUTOR' || roleKey === 'USER_GROUP_MANAGER') {
    return roleKey;
  }
  return 'CUSTOM';
}

export { SYSTEM_KEY_TO_ID };
