/**
 * Active Directory connector sync scope — which OUs and users to import.
 * Mirrors Google Workspace syncOrgUnits / syncUsers / includeSubOrgUnits.
 */

import type { AdDirectoryConfig } from '../adapters/ad-adapter.js';
import { parseCsvList } from './google-directory-config.js';

export interface AdSyncScope {
  orgUnits: string[];
  users: string[];
  includeSubOrgUnits: boolean;
}

function ldapAttr(entry: Record<string, unknown>, name: string): string {
  if (name.toLowerCase() === 'dn') {
    return entry['dn'] != null ? String(entry['dn']) : '';
  }
  const key = Object.keys(entry).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!key) return '';
  const val = entry[key];
  if (Array.isArray(val)) return val[0] != null ? String(val[0]) : '';
  return val != null ? String(val) : '';
}

export function resolveAdSyncScope(cfg: Record<string, unknown>): AdSyncScope {
  return {
    orgUnits: parseCsvList(cfg['syncOrgUnits']),
    users: parseCsvList(cfg['syncUsers']).map((u) => u.toLowerCase()),
    includeSubOrgUnits: cfg['includeSubOrgUnits'] !== false && cfg['includeSubOrgUnits'] !== 'false',
  };
}

/** Normalize a connector OU line to a full LDAP DN for search. */
export function normalizeAdOuDn(raw: string, domainRoot: string): string {
  const v = raw.trim();
  if (!v) return '';

  const root = domainRoot.trim();
  if (/DC=/i.test(v)) {
    return v.replace(/\s+/g, '');
  }

  let ouPath = v;
  if (!/^OU=/i.test(ouPath)) {
    ouPath = ouPath
      .split(',')
      .map((part) => {
        const t = part.trim();
        return /^OU=/i.test(t) ? t : `OU=${t}`;
      })
      .filter(Boolean)
      .join(',');
  }

  return root ? `${ouPath},${root}` : ouPath;
}

/** LDAP search bases for inbound user import (never includes provision OU unless listed). */
export function resolveAdSearchBases(scope: AdSyncScope, dir: AdDirectoryConfig): string[] {
  if (scope.orgUnits.length > 0) {
    const seen = new Set<string>();
    const bases: string[] = [];
    for (const ou of scope.orgUnits) {
      const dn = normalizeAdOuDn(ou, dir.domainRoot);
      const key = dn.replace(/\s+/g, '').toLowerCase();
      if (dn && !seen.has(key)) {
        seen.add(key);
        bases.push(dn);
      }
    }
    return bases;
  }

  const fallback = dir.searchBaseDn.trim() || dir.domainRoot;
  return fallback ? [fallback] : [];
}

export function dedupeAdDirectoryUsers<T extends Record<string, unknown>>(users: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const user of users) {
    const guidKey = Object.keys(user).find((k) => k.toLowerCase() === 'objectguid');
    const guidRaw = guidKey ? user[guidKey] : undefined;
    const guid = guidRaw != null ? String(Array.isArray(guidRaw) ? guidRaw[0] : guidRaw) : '';
    const dn = ldapAttr(user, 'dn').toLowerCase();
    const sam = ldapAttr(user, 'sAMAccountName').toLowerCase();
    const key = (guid && guid.length > 4 ? guid : '') || dn || sam;
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, user);
  }
  return [...byKey.values()];
}

/** Apply optional user allowlist after LDAP listing. */
export function filterAdUsersByScope<T extends Record<string, unknown>>(
  users: T[],
  scope: AdSyncScope,
): T[] {
  if (scope.users.length === 0) return users;
  const allow = new Set(scope.users);
  return users.filter((u) => {
    const mail = (ldapAttr(u, 'mail') || ldapAttr(u, 'userPrincipalName')).trim().toLowerCase();
    return mail && allow.has(mail);
  });
}

export function describeAdSyncScope(scope: AdSyncScope, userCount: number): string {
  const parts: string[] = [];
  if (scope.orgUnits.length) {
    parts.push(`${scope.orgUnits.length} OU(s)`);
  } else {
    parts.push('all OUs under Base DN');
  }
  if (scope.users.length) parts.push(`${scope.users.length} named user(s)`);
  return `Sync scope: ${parts.join(', ')} — ${userCount} user(s) matched`;
}
