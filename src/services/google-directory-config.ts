/**
 * Google Workspace connector scope — which OUs, groups, and users to sync.
 */

import { google } from 'googleapis';
import type { admin_directory_v1 } from 'googleapis';
import type { JWT } from 'google-auth-library';
import { config } from '../config.js';
import {
  emailAllowedForGoogleDomains,
  parseGoogleHostedDomains,
  primaryGoogleHostedDomain,
} from '../auth/google-domains.js';

export const GOOGLE_DIRECTORY_USER_SCOPE =
  'https://www.googleapis.com/auth/admin.directory.user';
export const GOOGLE_DIRECTORY_USER_READONLY_SCOPE =
  'https://www.googleapis.com/auth/admin.directory.user.readonly';
export const GOOGLE_DIRECTORY_GROUP_SCOPE =
  'https://www.googleapis.com/auth/admin.directory.group.readonly';

export type ConnectorSyncDirection = 'INBOUND' | 'OUTBOUND' | 'BIDIRECTIONAL';

export function normalizeConnectorDirection(raw: unknown): ConnectorSyncDirection {
  const d = String(raw ?? 'BIDIRECTIONAL').toUpperCase();
  if (d === 'INBOUND' || d === 'OUTBOUND') return d;
  return 'BIDIRECTIONAL';
}

/** Scopes to request at token time — must match Admin Console domain-wide delegation exactly. */
export function googleJwtScopes(direction: ConnectorSyncDirection = 'BIDIRECTIONAL'): string[] {
  const userScope = direction === 'INBOUND'
    ? GOOGLE_DIRECTORY_USER_READONLY_SCOPE
    : GOOGLE_DIRECTORY_USER_SCOPE;
  // Group read is always required — inbound mirrors memberships even when Sync Groups is blank.
  return [userScope, GOOGLE_DIRECTORY_GROUP_SCOPE];
}

export interface GoogleSyncScope {
  /** Primary domain label (first in list). */
  customerDomain: string;
  /** All Workspace domains on this tenant (used for portal login allowlist). */
  customerDomains: string[];
  adminEmail: string;
  provisionOrgUnit: string;
  orgUnits: string[];
  groups: string[];
  users: string[];
  includeSubOrgUnits: boolean;
  syncGroupMemberships: boolean;
}

export function parseGoogleServiceAccountKey(saKeyRaw: string): Record<string, string> {
  const raw = saKeyRaw.trim();
  if (!raw) {
    throw new Error('Google connector: serviceAccountKey is required in connector config (or GOOGLE_SA_KEY_JSON in .env)');
  }
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as Record<string, string>;
  }
}

/** True when Sync Groups means “all Workspace groups” (blank, `*`, or `ALL`). */
export function isGoogleGroupSyncAll(cfg: Record<string, unknown>): boolean {
  const raw = parseCsvList(cfg['syncGroups']);
  if (!raw.length) return true;
  return raw.length === 1 && (raw[0] === '*' || raw[0].toUpperCase() === 'ALL');
}

export function resolveGoogleImpersonationEmail(
  cfg: Record<string, unknown>,
  key: Record<string, string>,
): string {
  const admin = String(cfg['adminEmail'] ?? '').trim();
  if (!admin) {
    throw new Error(
      'Admin Email is required — enter a Google Workspace super admin (e.g. admin@company.com), not the service account address.',
    );
  }
  if (admin.endsWith('.gserviceaccount.com') || admin === key['client_email']) {
    throw new Error(
      'Admin Email must be a Workspace admin user to impersonate (domain-wide delegation). Do not use the service account email here.',
    );
  }
  return admin;
}

export function formatGoogleAuthError(
  err: unknown,
  cfg: Record<string, unknown>,
  direction: ConnectorSyncDirection = 'BIDIRECTIONAL',
): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (!raw.includes('unauthorized_client')) {
    return raw;
  }

  let clientId = '';
  try {
    const keyRaw = String(cfg['serviceAccountKey'] ?? config.google.saKeyJson ?? '').trim();
    if (keyRaw) {
      clientId = parseGoogleServiceAccountKey(keyRaw)['client_id'] ?? '';
    }
  } catch {
    // ignore parse errors in error formatter
  }

  const scopeCsv = googleJwtScopes(direction).join(',');
  const admin = String(cfg['adminEmail'] ?? '').trim() || '(not set)';
  const scopeHint = direction === 'INBOUND'
    ? 'INBOUND sync uses readonly scopes — delegate user.readonly + group.readonly (not the full user write scope).'
    : 'Both scopes above must be in the delegation list (user + group.readonly) — group sync runs even when Sync Groups is blank.';

  return [
    'Google rejected the service-account token (unauthorized_client).',
    'Check domain-wide delegation:',
    `1) Google Cloud Console → IAM → Service Accounts → enable "Domain-wide delegation" for this SA.`,
    `2) Google Admin Console → Security → API controls → Domain-wide delegation → Add new:`,
    `   Client ID: ${clientId || '(copy client_id from the JSON key)'}`,
    `   OAuth scopes: ${scopeCsv}`,
    `3) Admin Email must be a Workspace super admin (you set: ${admin}) — not the service account email.`,
    `4) ${scopeHint}`,
  ].join(' ');
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
  const customerDomains = parseGoogleHostedDomains(
    cfg['customerDomains'] ?? cfg['customerDomain'] ?? config.google.hostedDomain ?? '',
  );
  // `*` / `ALL` / blank = mirror all groups into IdP, not a user-import filter.
  const groupFilter = isGoogleGroupSyncAll(cfg)
    ? []
    : parseCsvList(cfg['syncGroups']).map((g) => g.toLowerCase());
  return {
    customerDomain: primaryGoogleHostedDomain(customerDomains),
    customerDomains,
    adminEmail: String(cfg['adminEmail'] ?? cfg['serviceAccountEmail'] ?? '').trim(),
    provisionOrgUnit: normalizeOrgUnitPath(String(cfg['provisionOrgUnit'] ?? '/Employees')),
    orgUnits: parseCsvList(cfg['syncOrgUnits']).map(normalizeOrgUnitPath),
    groups: groupFilter,
    users: parseCsvList(cfg['syncUsers']).map((u) => u.toLowerCase()),
    includeSubOrgUnits: cfg['includeSubOrgUnits'] !== false && cfg['includeSubOrgUnits'] !== 'false',
    // Default on: mirror memberships unless explicitly disabled.
    syncGroupMemberships:
      cfg['syncGroupMemberships'] !== false && cfg['syncGroupMemberships'] !== 'false',
  };
}

export function buildGoogleJwtAuth(
  cfg: Record<string, unknown>,
  direction: ConnectorSyncDirection = 'BIDIRECTIONAL',
): JWT {
  const saKeyRaw = String(cfg['serviceAccountKey'] ?? config.google.saKeyJson ?? '').trim();
  const key = parseGoogleServiceAccountKey(saKeyRaw);
  const impersonate = resolveGoogleImpersonationEmail(cfg, key);

  return new google.auth.JWT({
    email:   key['client_email'],
    key:     key['private_key'],
    scopes:  googleJwtScopes(direction),
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
  onPage?: (count: number) => void | Promise<void>,
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
    if (onPage) await onPage(users.length);
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
        const u = await directory.users.get({ userKey: m.email, projection: 'full' });
        if (u.data) members.push(u.data);
      } catch {
        // skip deleted or inaccessible members
      }
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return members;
}

function isGoogleUserNotFound(err: unknown): boolean {
  const e = err as { code?: number; response?: { status?: number } };
  return e?.code === 404 || e?.response?.status === 404;
}

export type GoogleDirectoryIdentity =
  | { kind: 'user'; user: admin_directory_v1.Schema$User; lookupEmail: string }
  | { kind: 'group'; groupEmail: string; name?: string }
  | { kind: 'not_found'; lookupEmail: string };

/** Resolve a Workspace login email to a user (incl. alias) or group. */
export async function lookupGoogleDirectoryIdentity(
  directory: admin_directory_v1.Admin,
  email: string,
): Promise<GoogleDirectoryIdentity> {
  const lookupEmail = email.trim().toLowerCase();
  if (!lookupEmail) return { kind: 'not_found', lookupEmail };

  try {
    const res = await directory.users.get({ userKey: lookupEmail, projection: 'full' });
    if (res.data) return { kind: 'user', user: res.data, lookupEmail };
  } catch (err) {
    if (!isGoogleUserNotFound(err)) throw err;
  }

  try {
    const gRes = await directory.groups.get({ groupKey: lookupEmail });
    if (gRes.data) {
      const out: Extract<GoogleDirectoryIdentity, { kind: 'group' }> = {
        kind: 'group',
        groupEmail: (gRes.data.email ?? lookupEmail).toLowerCase(),
      };
      if (gRes.data.name) out.name = gRes.data.name;
      return out;
    }
  } catch (err) {
    if (!isGoogleUserNotFound(err)) throw err;
  }

  return { kind: 'not_found', lookupEmail };
}

/** Direct lookup by primary email — reliable for explicit Sync Users allowlists. */
async function fetchGoogleUsersByEmail(
  directory: admin_directory_v1.Admin,
  emails: string[],
): Promise<{ users: admin_directory_v1.Schema$User[]; notFound: string[] }> {
  const users: admin_directory_v1.Schema$User[] = [];
  const notFound: string[] = [];

  for (const email of emails) {
    try {
      const res = await directory.users.get({ userKey: email, projection: 'full' });
      if (res.data) users.push(res.data);
    } catch (err) {
      if (isGoogleUserNotFound(err)) {
        notFound.push(email);
        continue;
      }
      throw err;
    }
  }

  return { users, notFound };
}

export interface ScopedGoogleUsersResult {
  users: admin_directory_v1.Schema$User[];
  notFoundEmails: string[];
}

/** List users matching connector OU / group scope; explicit Sync Users are always unioned in. */
export async function listScopedGoogleUsers(
  directory: admin_directory_v1.Admin,
  scope: GoogleSyncScope,
  opts: { onListingProgress?: (count: number) => void | Promise<void> } = {},
): Promise<ScopedGoogleUsersResult> {
  const hasOu     = scope.orgUnits.length > 0;
  const hasGroup  = scope.groups.length > 0;
  const hasUsers  = scope.users.length > 0;
  const notFoundEmails: string[] = [];

  if (!hasOu && !hasGroup && !hasUsers) {
    const users = await listAllGoogleUsers(directory, opts.onListingProgress);
    return { users, notFoundEmails };
  }

  if (hasUsers && !hasOu && !hasGroup) {
    const direct = await fetchGoogleUsersByEmail(directory, scope.users);
    return { users: direct.users, notFoundEmails: direct.notFound };
  }

  let pool: admin_directory_v1.Schema$User[];

  if (hasOu) {
    const all = await listAllGoogleUsers(directory, opts.onListingProgress);
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
    pool = await listAllGoogleUsers(directory, opts.onListingProgress);
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
    const byId = new Map<string, admin_directory_v1.Schema$User>();
    for (const u of pool) {
      const id = u.id ?? userEmail(u);
      if (id) byId.set(id, u);
    }
    const presentEmails = new Set([...byId.values()].map((u) => userEmail(u)));
    const toFetch = scope.users.filter((e) => !presentEmails.has(e));
    if (toFetch.length > 0) {
      const direct = await fetchGoogleUsersByEmail(directory, toFetch);
      notFoundEmails.push(...direct.notFound);
      for (const u of direct.users) {
        const id = u.id ?? userEmail(u);
        if (id) byId.set(id, u);
      }
    }
    if (hasOu || hasGroup) {
      // Explicit Sync Users are unioned into the scoped pool (included even outside OU/group filters).
      pool = [...byId.values()];
    } else {
      const allow = new Set(scope.users);
      pool = [...byId.values()].filter((u) => allow.has(userEmail(u)));
    }
  }

  return { users: pool, notFoundEmails };
}

/** Whether outbound reconcile should touch this employee (respects sync scope). */
export function employeeEligibleForGoogleOutbound(
  emailCorp: string,
  scope: GoogleSyncScope,
  hasGoogleLink: boolean,
): boolean {
  if (hasGoogleLink) return true;

  const email = emailCorp.trim().toLowerCase();
  if (!email) return false;

  if (scope.customerDomains.length > 0 && !emailAllowedForGoogleDomains(email, scope.customerDomains)) {
    return false;
  }

  const hasScopeFilter = scope.orgUnits.length > 0 || scope.groups.length > 0 || scope.users.length > 0;
  if (!hasScopeFilter) return true;

  if (scope.users.length > 0) {
    return scope.users.includes(email);
  }

  // OU / group scope is inbound-only — do not auto-provision every IdP employee to Google.
  return false;
}
