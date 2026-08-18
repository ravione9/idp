/**
 * Lightweight LDAP client for the on-prem AD agent.
 * Mirrors the IdP ADAdapter surface used during bidirectional sync.
 */
import { Client, Attribute, Change } from 'ldapts';
import crypto from 'node:crypto';
import type { AdConfig } from './config.js';

const UAC_NORMAL = 0x0200;
const UAC_DISABLE = 0x0002;
const UAC_DISABLED_ACCOUNT = UAC_NORMAL | UAC_DISABLE;

/** Attributes needed for IdP inbound sync (avoid posting full LDAP `*` — exceeds IdP JSON limit). */
export const USER_IMPORT_ATTRS = [
  'dn', 'sAMAccountName', 'mail', 'userPrincipalName', 'displayName', 'cn',
  'givenName', 'sn', 'objectGUID', 'employeeID', 'employeeNumber', 'userAccountControl',
  'department', 'title', 'manager', 'description', 'pager', 'initials', 'info',
  ...Array.from({ length: 15 }, (_, i) => `extensionAttribute${i + 1}`),
];

function domainRootFromBaseDn(baseDn: string): string {
  return baseDn.split(',').map((p) => p.trim()).filter((p) => /^DC=/i.test(p)).join(',');
}

function ldapEscape(value: string): string {
  return value.replace(/[\\*()\x00]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

function getAttr(entry: Record<string, unknown>, name: string): string {
  const v = entry[name];
  if (v == null) return '';
  if (Array.isArray(v)) return String(v[0] ?? '');
  return String(v);
}

/** Convert AD objectGUID binary to canonical UUID (matches IdP readAdObjectGuid). */
function formatObjectGuid(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'string') {
    const s = raw.trim().replace(/^[{\[]|[}\]]$/g, '');
    if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s)) {
      return s.toUpperCase();
    }
    return '';
  }
  const buf = Buffer.isBuffer(raw)
    ? raw
    : Array.isArray(raw) && raw[0] != null && Buffer.isBuffer(raw[0])
      ? raw[0]
      : null;
  if (!buf || buf.length !== 16) return '';
  const reordered = Buffer.from([
    buf[3], buf[2], buf[1], buf[0],
    buf[5], buf[4],
    buf[7], buf[6],
    ...buf.subarray(8, 16),
  ]);
  const hex = reordered.toString('hex').toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function getObjectGuidAttr(entry: Record<string, unknown>): string {
  const key = Object.keys(entry).find((k) => k.toLowerCase() === 'objectguid');
  if (!key) return '';
  const val = entry[key];
  return formatObjectGuid(Array.isArray(val) ? val[0] : val);
}

function domainFromBaseDn(baseDn: string): string {
  return baseDn.split(',').filter((p) => p.toUpperCase().startsWith('DC='))
    .map((p) => p.slice(3))
    .join('.');
}

function normalizeOuDn(raw: string, domainRoot: string): string {
  const v = raw.trim();
  if (!v) return '';
  if (/DC=/i.test(v)) return v.replace(/\s+/g, '');
  let ouPath = v;
  if (!/^OU=/i.test(ouPath)) {
    ouPath = ouPath.split(',').map((part) => {
      const t = part.trim();
      return /^OU=/i.test(t) ? t : `OU=${t}`;
    }).filter(Boolean).join(',');
  }
  return domainRoot ? `${ouPath},${domainRoot}` : ouPath;
}

function parseScopeList(raw?: string): string[] {
  if (!raw?.trim()) return [];
  return raw.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
}

function resolveSearchBases(
  baseDn: string,
  syncOrgUnits?: string,
): { bases: string[]; includeSubOrgUnits: boolean } {
  const domainRoot = domainRootFromBaseDn(baseDn) || baseDn;
  const orgUnits = parseScopeList(syncOrgUnits);
  if (orgUnits.length > 0) {
    const bases = [...new Set(orgUnits.map((ou) => normalizeOuDn(ou, domainRoot).toLowerCase()))]
      .map((key) => orgUnits.map((ou) => normalizeOuDn(ou, domainRoot)).find((b) => b.toLowerCase() === key)!)
      .filter(Boolean);
    return { bases, includeSubOrgUnits: true };
  }
  return { bases: [baseDn], includeSubOrgUnits: true };
}

function inboundAdUserLdapFilter(): string {
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

function isImportableAdDirectoryUser(user: Record<string, unknown>): boolean {
  const sam = getAttr(user, 'sAMAccountName').trim().toLowerCase();
  if (!sam || sam.endsWith('$')) return false;
  if (BUILTIN_SAM_BLOCKLIST.has(sam)) return false;
  if (sam.startsWith('sm_')) return false;

  const critical = getAttr(user, 'isCriticalSystemObject').toUpperCase();
  if (critical === 'TRUE') return false;

  const mail = (getAttr(user, 'mail') || getAttr(user, 'userPrincipalName')).trim();
  const empId = getAttr(user, 'employeeID').trim();
  if (!mail && !empId) return false;

  return true;
}

function filterUsersByAllowlist(
  users: Record<string, unknown>[],
  syncUsers?: string,
): Record<string, unknown>[] {
  const allow = parseScopeList(syncUsers).map((u) => u.toLowerCase());
  if (!allow.length) return users;
  return users.filter((u) => {
    const mail = (getAttr(u, 'mail') || getAttr(u, 'userPrincipalName')).trim().toLowerCase();
    return mail && allow.includes(mail);
  });
}

function dedupeUsers(users: Record<string, unknown>[]): Record<string, unknown>[] {
  const byKey = new Map<string, Record<string, unknown>>();
  for (const u of users) {
    const guid = getObjectGuidAttr(u);
    const dn = getAttr(u, 'dn').toLowerCase();
    const sam = getAttr(u, 'sAMAccountName').toLowerCase();
    const key = guid || dn || sam;
    if (key && !byKey.has(key)) byKey.set(key, u);
  }
  return [...byKey.values()];
}

function encodeAdPassword(password: string): Buffer {
  return Buffer.from(`"${password}"`, 'utf16le');
}

export class AdLdapClient {
  private client: Client;
  private connected = false;
  private readonly tlsOpts = { rejectUnauthorized: false };
  private readonly url: string;

  constructor(private readonly ad: AdConfig) {
    this.url = `${ad.useSsl ? 'ldaps' : 'ldap'}://${ad.host}:${ad.port}`;
    this.client = this.createClient();
  }

  private createClient(): Client {
    return new Client({
      url: this.url,
      connectTimeout: 10_000,
      timeout: 30_000,
      tlsOptions: this.tlsOpts,
    });
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.connect();
      await this.client.search(this.ad.baseDn, {
        scope: 'base',
        filter: '(objectClass=*)',
        attributes: ['dn'],
      });
      await this.disconnect();
      const proto = this.ad.useSsl ? 'LDAPS' : this.ad.startTls ? 'LDAP+StartTLS' : 'LDAP';
      return { ok: true, message: `${proto} bind OK - ${this.url}` };
    } catch (err) {
      await this.disconnect().catch(() => undefined);
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.ad.startTls) await this.client.startTLS(this.tlsOpts);
    await this.client.bind(this.ad.bindDn, this.ad.bindPassword);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.client.unbind().catch(() => undefined);
      this.connected = false;
    }
    this.client = this.createClient();
  }

  private async searchPaged(
    base: string,
    filter: string,
    attributes: string[],
    scope: 'sub' | 'one',
  ): Promise<Record<string, unknown>[]> {
    await this.connect();
    const entries: Record<string, unknown>[] = [];
    for await (const result of this.client.searchPaginated(base, {
      scope,
      filter,
      attributes,
      paged: { pageSize: 900 },
    })) {
      entries.push(...(result.searchEntries as Record<string, unknown>[]));
    }
    return entries;
  }

  private async search(base: string, filter: string, attributes: string[]): Promise<Record<string, unknown>[]> {
    await this.connect();
    const result = await this.client.search(base, { scope: 'sub', filter, attributes, sizeLimit: 5000 });
    return result.searchEntries as Record<string, unknown>[];
  }

  async listUsers(options?: {
    syncOrgUnits?: string;
    syncUsers?: string;
    includeSubOrgUnits?: boolean;
  }): Promise<Record<string, unknown>[]> {
    const filter = inboundAdUserLdapFilter();
    const { bases } = resolveSearchBases(this.ad.baseDn, options?.syncOrgUnits);
    const ldapScope = options?.includeSubOrgUnits === false ? 'one' : 'sub';
    const merged: Record<string, unknown>[] = [];

    for (const base of bases) {
      try {
        const batch = await this.searchPaged(base, filter, USER_IMPORT_ATTRS, ldapScope);
        merged.push(...batch);
      } catch {
        // try remaining bases
      }
    }

    const users = dedupeUsers(merged).filter(isImportableAdDirectoryUser);
    return filterUsersByAllowlist(users, options?.syncUsers);
  }

  async findByEmployeeId(empId: string): Promise<Record<string, unknown> | null> {
    const entries = await this.search(
      this.ad.baseDn,
      `(&(objectClass=user)(employeeID=${ldapEscape(empId)}))`,
      ['sAMAccountName', 'dn', 'mail'],
    );
    return entries[0] ?? null;
  }

  async findByEmail(email: string): Promise<Record<string, unknown> | null> {
    const esc = ldapEscape(email);
    const entries = await this.search(
      this.ad.baseDn,
      `(&(objectClass=user)(|(mail=${esc})(userPrincipalName=${esc})))`,
      ['sAMAccountName', 'dn', 'mail'],
    );
    return entries[0] ?? null;
  }

  async createUser(params: {
    empId: string;
    fullName: string;
    emailCorp: string;
    sAMAccountName: string;
    department?: string;
    title?: string;
    targetOuRdn?: string;
    upnDomain?: string;
  }): Promise<string> {
    if (!this.ad.useSsl && !this.ad.startTls) {
      throw new Error('Provisioning requires LDAPS or StartTLS');
    }

    await this.connect();
    const sam = params.sAMAccountName.slice(0, 20).replace(/[^a-zA-Z0-9._-]/g, '');
    const ouRdn = params.targetOuRdn?.trim()
      || (this.ad.targetOu?.includes('=') ? this.ad.targetOu : `OU=${this.ad.targetOu ?? 'Users'}`);
    const dn = `CN=${sam},${ouRdn},${this.ad.baseDn}`;
    const upnDomain = params.upnDomain?.trim() || this.ad.upnDomain || domainFromBaseDn(this.ad.baseDn);
    const tempPassword = crypto.randomBytes(12).toString('base64url').slice(0, 16) + 'Aa1!';

    const entry: Record<string, string | string[]> = {
      objectClass: ['top', 'person', 'organizationalPerson', 'user'],
      cn: sam,
      sAMAccountName: sam,
      userPrincipalName: `${sam}@${upnDomain}`.toLowerCase(),
      mail: params.emailCorp.toLowerCase(),
      displayName: params.fullName.slice(0, 256),
      givenName: params.fullName.split(/\s+/)[0]?.slice(0, 64) ?? sam,
      sn: params.fullName.split(/\s+/).slice(1).join(' ').slice(0, 64) || sam,
      employeeID: params.empId,
      userAccountControl: String(UAC_DISABLED_ACCOUNT),
    };
    if (params.department) entry['department'] = params.department.slice(0, 64);
    if (params.title) entry['title'] = params.title.slice(0, 128);

    await this.client.add(dn, entry);
    await this.client.modify(dn, [
      new Change({
        operation: 'replace',
        modification: new Attribute({ type: 'unicodePwd', values: [encodeAdPassword(tempPassword)] }),
      }),
    ]);
    await this.client.modify(dn, [
      new Change({
        operation: 'replace',
        modification: new Attribute({ type: 'userAccountControl', values: [String(UAC_NORMAL)] }),
      }),
      new Change({
        operation: 'replace',
        modification: new Attribute({ type: 'pwdLastSet', values: ['0'] }),
      }),
    ]);

    return sam;
  }

  async disableUser(sam: string): Promise<void> {
    await this.connect();
    const entries = await this.search(
      this.ad.baseDn,
      `(&(objectClass=user)(sAMAccountName=${ldapEscape(sam)}))`,
      ['dn'],
    );
    if (!entries.length) return;
    const currentDn = getAttr(entries[0], 'dn');
    await this.client.modify(currentDn, [
      new Change({
        operation: 'replace',
        modification: new Attribute({ type: 'userAccountControl', values: [String(UAC_DISABLED_ACCOUNT)] }),
      }),
    ]);
    const disabledOu = this.ad.disabledOu ?? 'OU=Disabled,';
    if (!currentDn.toUpperCase().includes(disabledOu.toUpperCase())) {
      const cn = currentDn.split(',')[0];
      await this.client.modifyDN(currentDn, `${cn},${disabledOu}${this.ad.baseDn}`);
    }
  }

  async enableUser(sam: string): Promise<void> {
    await this.connect();
    const entries = await this.search(
      this.ad.baseDn,
      `(&(objectClass=user)(sAMAccountName=${ldapEscape(sam)}))`,
      ['dn'],
    );
    if (!entries.length) return;
    const currentDn = getAttr(entries[0], 'dn');
    await this.client.modify(currentDn, [
      new Change({
        operation: 'replace',
        modification: new Attribute({ type: 'userAccountControl', values: [String(UAC_NORMAL)] }),
      }),
    ]);
  }

  /** List security groups (max 200), skipping built-in domain groups. */
  async listDirectoryGroups(): Promise<Array<{ dn: string; name: string; sam?: string }>> {
    const skipCn = new Set([
      'domain users', 'domain computers', 'domain controllers',
      'domain admins', 'domain guests', 'group policy creator owners',
      'read-only domain controllers', 'cloneable domain controllers',
      'dnsadmins', 'enterprise admins', 'schema admins',
    ]);
    const entries = await this.search(
      this.ad.baseDn,
      '(&(objectClass=group)(sAMAccountName=*))',
      ['dn', 'cn', 'displayName', 'sAMAccountName'],
    );
    const out: Array<{ dn: string; name: string; sam?: string }> = [];
    const seen = new Set<string>();
    for (const e of entries) {
      const dn = getAttr(e, 'dn');
      if (!dn || seen.has(dn.toLowerCase())) continue;
      const cn = getAttr(e, 'cn').toLowerCase();
      if (skipCn.has(cn)) continue;
      seen.add(dn.toLowerCase());
      const sam = getAttr(e, 'sAMAccountName');
      const name = getAttr(e, 'displayName') || getAttr(e, 'cn') || sam || dn;
      out.push(sam ? { dn, name, sam } : { dn, name });
      if (out.length >= 200) break;
    }
    return out;
  }

  async findGroup(groupKey: string): Promise<{ dn: string; name: string; sam?: string } | null> {
    const key = groupKey.trim();
    if (!key) return null;
    if (key.includes('=') && key.includes(',')) {
      const entries = await this.search(key, '(objectClass=group)', ['dn', 'cn', 'displayName', 'sAMAccountName']);
      if (!entries.length) return null;
      const e = entries[0];
      const dn = getAttr(e, 'dn');
      const sam = getAttr(e, 'sAMAccountName');
      const name = getAttr(e, 'displayName') || getAttr(e, 'cn') || sam || dn;
      return sam ? { dn, name, sam } : { dn, name };
    }
    const esc = ldapEscape(key);
    const entries = await this.search(
      this.ad.baseDn,
      `(&(objectClass=group)(|(cn=${esc})(sAMAccountName=${esc})))`,
      ['dn', 'cn', 'displayName', 'sAMAccountName'],
    );
    if (!entries.length) return null;
    const e = entries[0];
    const dn = getAttr(e, 'dn');
    const sam = getAttr(e, 'sAMAccountName');
    const name = getAttr(e, 'displayName') || getAttr(e, 'cn') || sam || dn;
    return sam ? { dn, name, sam } : { dn, name };
  }

  async listGroupMemberUsers(groupDn: string): Promise<Array<{ sam: string; mail?: string; upn?: string; employeeId?: string }>> {
    const groupEntries = await this.search(groupDn, '(objectClass=group)', ['member']);
    if (!groupEntries.length) return [];

    const raw = groupEntries[0]['member'];
    const memberDns: string[] = Array.isArray(raw)
      ? raw.map(String)
      : (raw ? [String(raw)] : []);

    const users: Array<{ sam: string; mail?: string; upn?: string; employeeId?: string }> = [];
    for (const memberDn of memberDns.slice(0, 1000)) {
      try {
        const uEntries = await this.search(
          memberDn,
          '(&(objectClass=user)(!(sAMAccountName=*$)))',
          ['sAMAccountName', 'mail', 'userPrincipalName', 'employeeID', 'userAccountControl'],
        );
        if (!uEntries.length) continue;
        const u = uEntries[0];
        const uac = Number(getAttr(u, 'userAccountControl') || '0');
        if (uac & UAC_DISABLE) continue;
        const sam = getAttr(u, 'sAMAccountName');
        if (!sam) continue;
        const mail = getAttr(u, 'mail');
        const upn = getAttr(u, 'userPrincipalName');
        const employeeId = getAttr(u, 'employeeID');
        const row: { sam: string; mail?: string; upn?: string; employeeId?: string } = { sam };
        if (mail) row.mail = mail;
        if (upn) row.upn = upn;
        if (employeeId) row.employeeId = employeeId;
        users.push(row);
      } catch {
        // nested groups / contacts — skip
      }
    }
    return users;
  }

  /** Resolve group keys from connector syncGroups config (blank/* = all security groups). */
  async resolveGroupKeys(syncGroupsRaw: string): Promise<{ keys: string[]; errors: string[] }> {
    const raw = syncGroupsRaw
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (!raw.length) {
      const all = await this.listDirectoryGroups();
      if (!all.length) return { keys: [], errors: ['No AD security groups found under domain root'] };
      return { keys: all.map((g) => g.dn), errors: [] };
    }

    if (raw.length === 1 && (raw[0] === '*' || raw[0].toUpperCase() === 'ALL')) {
      const all = await this.listDirectoryGroups();
      if (!all.length) return { keys: [], errors: ['No AD security groups found under domain root'] };
      return { keys: all.map((g) => g.dn), errors: [] };
    }

    return { keys: raw, errors: [] };
  }

  async collectGroupsForSync(syncGroupsRaw: string): Promise<{
    groups: Array<{ dn: string; name: string; sam?: string; members: Array<{ sam: string; mail?: string; upn?: string; employeeId?: string }> }>;
    errors: string[];
  }> {
    const resolved = await this.resolveGroupKeys(syncGroupsRaw);
    const groups: Array<{ dn: string; name: string; sam?: string; members: Array<{ sam: string; mail?: string; upn?: string; employeeId?: string }> }> = [];
    const errors = [...resolved.errors];

    for (const groupKey of resolved.keys) {
      try {
        const g = await this.findGroup(groupKey);
        if (!g) {
          errors.push(`${groupKey}: group not found in AD`);
          continue;
        }
        const members = await this.listGroupMemberUsers(g.dn);
        groups.push({ dn: g.dn, name: g.name, ...(g.sam ? { sam: g.sam } : {}), members });
      } catch (err) {
        errors.push(`${groupKey}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { groups, errors };
  }
}

export { getAttr };
