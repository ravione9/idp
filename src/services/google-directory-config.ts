/**
 * Google Workspace connector scope — which OUs, groups, and users to sync.
 */

import { google } from 'googleapis';
import type { admin_directory_v1 } from 'googleapis';
import type { JWT } from 'google-auth-library';
import { config } from '../config.js';

export interface GoogleSyncScope {
  customerDomain: string;
  adminEmail: string;
  provisionOrgUnit: string;
  orgUnits: string[];
  groups: string[];
  users: string[];
  includeSubOrgUnits: boolean;
  syncGroupMemberships: boolean;
}

export function parseCsvList(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v).trim()).filter(Boolean);
  }
  return String(raw)
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Normalize Google OU path (always starts with /). */
export function normalizeOrgUnitPath(path: string): string {
  const p = path.trim();
  if (!p || p === '/') return '/';
  return p.startsWith('/') ? p.replace(/\/+$/, '') || '/' : `/${p}`.replace(/\/+$/, '');
}

export function resolveGoogleSyncScope(cfg: Record<string, unknown>): GoogleSyncScope {
  return {
    customerDomain: String(cfg['customerDomain'] ?? config.google.hostedDomain ?? '').trim(),
    adminEmail: String(cfg['adminEmail'] ?? cfg['serviceAccountEmail'] ?? '').trim(),
    provisionOrgUnit: normalizeOrgUnitPath(String(cfg['provisionOrgUnit'] ?? '/Employees')),
    orgUnits: parseCsvList(cfg['syncOrgUnits']).map(normalizeOrgUnitPath),
    groups: parseCsvList(cfg['syncGroups']).map((g) => g.toLowerCase()),
    users: parseCsvList(cfg['syncUsers']).map((u) => u.toLowerCase()),
    includeSubOrgUnits: cfg['includeSubOrgUnits'] !== false && cfg['includeSubOrgUnits'] !== 'false',
    syncGroupMemberships: cfg['syncGroupMemberships'] === true || cfg['syncGroupMemberships'] === 'true',
  };
}

export function buildGoogleJwtAuth(cfg: Record<string, unknown>): JWT {
  const saKeyRaw = String(cfg['serviceAccountKey'] ?? config.google.saKeyJson ?? '').trim();
  if (!saKeyRaw) {
    throw new Error('Google connector: serviceAccountKey is required in connector config (or GOOGLE_SA_KEY_JSON in .env)');
  }

  let key: Record<string, string>;
  try {
    key = JSON.parse(saKeyRaw) as Record<string, string>;
  } catch {
    key = JSON.parse(Buffer.from(saKeyRaw, 'base64').toString('utf8')) as Record<string, string>;
  }

  const impersonate = String(cfg['adminEmail'] ?? '').trim() || key['client_email'];

  return new google.auth.JWT({
    email:   key['client_email'],
    key:     key['private_key'],
    scopes:  [
      'https://www.googleapis.com/auth/admin.directory.user',
      'https://www.googleapis.com/auth/admin.directory.group.readonly',
      'https://www.googleapis.com/auth/admin.directory.orgunit.readonly',
    ],
    subject: impersonate,
  });
}

function userEmail(u: admin_directory_v1.Schema$User): string {
  return (u.primaryEmail ?? '').trim().toLowerCase();
}

function userInOrgUnit(u: admin_directory_v1.Schema$User, ou: string, includeChildren: boolean): boolean {
  const path = normalizeOrgUnitPath(u.orgUnitPath ?? '/');
  if (!includeChildren) return path === ou;
  return path === ou || path.startsWith(`${ou}/`);
}

async function listAllGoogleUsers(
  directory: admin_directory_v1.Admin,
): Promise<admin_directory_v1.Schema$User[]> {
  const users: admin_directory_v1.Schema$User[] = [];
  let pageToken: string | undefined;

  do {
    const res = await directory.users.list({
      customer:   'my_customer',
      maxResults: 500,
      orderBy:    'email',
      projection: 'full',
      ...(pageToken ? { pageToken } : {}),
    });
    users.push(...(res.data.users ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return users;
}

async function listUsersInGroup(
  directory: admin_directory_v1.Admin,
  groupEmail: string,
): Promise<admin_directory_v1.Schema$User[]> {
  const members: admin_directory_v1.Schema$User[] = [];
  let pageToken: string | undefined;

  do {
    const res = await directory.members.list({
      groupKey:   groupEmail,
      maxResults: 200,
      ...(pageToken ? { pageToken } : {}),
    });

    for (const m of res.data.members ?? []) {
      if (m.type !== 'USER' || !m.email) continue;
      try {
        const u = await directory.users.get({ userKey: m.email });
        if (u.data) members.push(u.data);
      } catch {
        // skip deleted or inaccessible members
      }
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return members;
}

/** List users matching connector OU / group / user scope (AND across non-empty filters). */
export async function listScopedGoogleUsers(
  directory: admin_directory_v1.Admin,
  scope: GoogleSyncScope,
): Promise<admin_directory_v1.Schema$User[]> {
  const hasOu     = scope.orgUnits.length > 0;
  const hasGroup  = scope.groups.length > 0;
  const hasUsers  = scope.users.length > 0;

  if (!hasOu && !hasGroup && !hasUsers) {
    return listAllGoogleUsers(directory);
  }

  let pool: admin_directory_v1.Schema$User[];

  if (hasOu) {
    const all = await listAllGoogleUsers(directory);
    pool = all.filter((u) =>
      scope.orgUnits.some((ou) => userInOrgUnit(u, ou, scope.includeSubOrgUnits)),
    );
  } else if (hasGroup) {
    const byId = new Map<string, admin_directory_v1.Schema$User>();
    for (const g of scope.groups) {
      const members = await listUsersInGroup(directory, g);
      for (const u of members) {
        const id = u.id ?? userEmail(u);
        if (id) byId.set(id, u);
      }
    }
    pool = [...byId.values()];
  } else {
    pool = await listAllGoogleUsers(directory);
  }

  if (hasGroup && hasOu) {
    const groupEmails = new Set<string>();
    for (const g of scope.groups) {
      const members = await listUsersInGroup(directory, g);
      for (const u of members) groupEmails.add(userEmail(u));
    }
    pool = pool.filter((u) => groupEmails.has(userEmail(u)));
  }

  if (hasUsers) {
    const allow = new Set(scope.users);
    pool = pool.filter((u) => allow.has(userEmail(u)));
  }

  return pool;
}
