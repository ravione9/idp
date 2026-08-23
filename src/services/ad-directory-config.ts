/**
 * Active Directory connector sync scope — which OUs and users to import.
 * Mirrors Google Workspace syncOrgUnits / syncUsers / includeSubOrgUnits.
 */

import type { AdDirectoryConfig } from '../adapters/ad-adapter.js';
import { normalizeGoogleDomain, parseGoogleHostedDomains } from '../auth/google-domains.js';
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

/** LDAP search depth: blank Sync OUs always uses subtree (all nested OUs under Base DN). */
export function resolveAdLdapScope(scope: AdSyncScope): 'sub' | 'one' {
  if (scope.orgUnits.length === 0) return 'sub';
  return scope.includeSubOrgUnits ? 'sub' : 'one';
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
    const mail = resolveAdCorporateEmail(u).trim().toLowerCase();
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

export function domainFromAdRoot(domainRoot: string): string {
  return domainRoot
    .split(',')
    .map((p) => p.trim())
    .filter((p) => /^DC=/i.test(p))
    .map((p) => p.slice(3))
    .join('.')
    .toLowerCase();
}

export function resolveAdDefaultEmailDomain(
  cfg: Record<string, unknown>,
  dir: AdDirectoryConfig,
): string {
  return parseAdUpnDomains(cfg, dir)[0] ?? 'lenskart.in';
}

/** All UPN suffixes for this connector (multi-line upnDomain / upnDomains). */
export function parseAdUpnDomains(cfg: Record<string, unknown>, dir: AdDirectoryConfig): string[] {
  const fromCfg = parseGoogleHostedDomains(
    cfg['upnDomains'] ?? cfg['upnDomain'] ?? cfg['customerDomains'] ?? cfg['customerDomain'] ?? '',
  );
  if (fromCfg.length) return fromCfg;
  const fromRoot = domainFromAdRoot(dir.domainRoot);
  return fromRoot ? [fromRoot] : ['lenskart.in'];
}

/** UPN suffix for outbound AD provision — matches employee email domain when listed. */
export function resolveUpnSuffixForProvision(emailCorp: string, domains: string[]): string {
  const email = emailCorp.trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at > 0) {
    const suffix = normalizeGoogleDomain(email.slice(at + 1));
    if (!domains.length || domains.includes(suffix)) return suffix;
  }
  return domains[0] ?? 'lenskart.in';
}

/** Best corporate email for an AD LDAP entry (mail → UPN as-is → sAM@firstConfiguredDomain). */
export function resolveAdCorporateEmail(
  user: Record<string, unknown>,
  defaultDomains?: string | string[],
): string {
  const mail = ldapAttr(user, 'mail').trim().toLowerCase();
  if (mail.includes('@')) return mail;

  const upn = ldapAttr(user, 'userPrincipalName').trim().toLowerCase();
  if (upn.includes('@')) return upn;

  const sam = ldapAttr(user, 'sAMAccountName').trim().toLowerCase();
  const domains = Array.isArray(defaultDomains)
    ? defaultDomains
    : defaultDomains
      ? [defaultDomains]
      : [];
  for (const raw of domains) {
    const domain = raw.trim().toLowerCase().replace(/^@+/, '');
    if (sam && domain) return `${sam}@${domain}`;
  }

  return '';
}

/** True when AD account is enabled (userAccountControl bit 0x0002 clear). */
export function isAdAccountEnabled(user: Record<string, unknown>): boolean {
  const uac = parseInt(ldapAttr(user, 'userAccountControl') || '512', 10);
  return (uac & 0x0002) === 0;
}

/** LDAP filter for inbound person accounts (excludes computers and built-in system users). */
export function inboundAdUserLdapFilter(): string {
  return [
    '(&(objectCategory=person)(objectClass=user)',
    '(!(sAMAccountName=*$))',
    '(!(sAMAccountName=krbtgt))',
    '(!(sAMAccountName=Guest))',
    '(!(isCriticalSystemObject=TRUE))',
    ')',
  ].join('');
}

const BUILTIN_SAM_BLOCKLIST = new Set([
  'krbtgt', 'guest', 'administrator', 'defaultaccount',
  'wdagutilityaccount', 'healthmailbox',
]);

/** Drop built-in / service-style rows that slip through the LDAP filter.
 *  employeeID is optional — sAMAccountName is sufficient for import (IdP assigns AD- hash emp_id). */
export function isImportableAdDirectoryUser(
  user: Record<string, unknown>,
  _defaultDomain?: string,
): boolean {
  const sam = ldapAttr(user, 'sAMAccountName').trim().toLowerCase();
  if (!sam || sam.endsWith('$')) return false;
  if (BUILTIN_SAM_BLOCKLIST.has(sam)) return false;
  if (sam.startsWith('sm_')) return false;

  const critical = ldapAttr(user, 'isCriticalSystemObject').toUpperCase();
  if (critical === 'TRUE') return false;

  return true;
}

/** Outbound provision: skip auto-create for Google-only employees or when OU scope is inbound-only. */
export function employeeEligibleForAdProvision(
  emailCorp: string,
  scope: AdSyncScope,
  hasGoogleLink: boolean,
): boolean {
  const email = emailCorp.trim().toLowerCase();
  if (!email) return false;

  if (scope.users.length > 0) {
    return scope.users.includes(email);
  }

  if (scope.orgUnits.length > 0) {
    // OU scope is inbound-only — never create AD accounts for the whole IdP catalog.
    return false;
  }

  // Full-directory inbound scope: still skip employees that only exist via Google sync.
  if (hasGoogleLink) return false;

  return true;
}
