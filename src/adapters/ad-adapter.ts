import { Client, Attribute, Change } from 'ldapts';
import { Redis } from 'ioredis';
import { BaseAdapter, AdapterResult, UserInfo, Binding } from './base-adapter.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// AD userAccountControl flags
// ---------------------------------------------------------------------------
const UAC_NORMAL_ACCOUNT  = 0x0200; // 512  — enabled
const UAC_ACCOUNTDISABLE  = 0x0002; // 2
const UAC_DISABLED_ACCOUNT = UAC_NORMAL_ACCOUNT | UAC_ACCOUNTDISABLE; // 514

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface ADUser {
  dn: string;
  sAMAccountName?: string;
  employeeID?: string;
  mail?: string;
  displayName?: string;
  userAccountControl?: string;
  memberOf?: string[];
  extensionAttribute1?: string; // OU category
  extensionAttribute2?: string; // target OU path for re-enable
  [key: string]: unknown;
}

/** Resolved LDAP naming context from connector Base DN + New User OU fields. */
export interface AdDirectoryConfig {
  searchBaseDn: string;
  domainRoot: string;
  provisionOuRdn: string;
  provisionOuDn: string;
  inferredProvisionOu: boolean;
}

// ---------------------------------------------------------------------------
// ADAdapter
// ---------------------------------------------------------------------------
export class ADAdapter extends BaseAdapter {
  private client: Client;
  private connected = false;
  private readonly dir: AdDirectoryConfig;

  constructor(
    redis: Redis,
    private readonly url: string,
    private readonly bindDn: string,
    private readonly bindPassword: string,
    baseDn: string,
    private readonly disabledOu = 'OU=Disabled,',
    private readonly startTls = false,
    targetOuRaw = '',
  ) {
    super(redis, 'AD', { minRequests: 10, errorThreshold: 75 });
    this.dir = resolveAdDirectoryConfig(baseDn, targetOuRaw);
    this.client = this.createClient();
  }

  /** LDAP search base from connector config. */
  private get baseDn(): string {
    return this.dir.searchBaseDn;
  }

  /** LDAPS or StartTLS — required before writing unicodePwd. */
  connectionIsSecure(): boolean {
    return this.url.startsWith('ldaps://') || this.startTls;
  }

  // ---------------------------------------------------------------------------
  // Connection management
  // ---------------------------------------------------------------------------
  // Enterprise AD DCs typically use certificates from an internal CA that is
  // not in Node's trust store — skip verification for internal directory servers.
  private readonly tlsOpts = { rejectUnauthorized: false };

  private createClient(): Client {
    return new Client({
      url:              this.url,
      connectTimeout:   10_000,
      timeout:          15_000,
      tlsOptions:       this.tlsOpts,
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    try {
      if (this.startTls) {
        await this.client.startTLS(this.tlsOpts);
        logger.info({ url: this.url }, 'AD: StartTLS negotiated');
      }
      await this.client.bind(this.bindDn, this.bindPassword);
      this.connected = true;
      logger.info({ url: this.url, startTls: this.startTls }, 'AD: LDAP bind successful');
    } catch (err) {
      this.connected = false;
      this.client = this.createClient(); // fresh client on failure
      throw err;
    }
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.client.unbind();
      this.connected = false;
      logger.info('AD: LDAP unbound');
    }
  }

  /** Build full DN for an OU RDN relative to the domain root. */
  buildOuDn(ouRdn?: string): string {
    if (!ouRdn?.trim()) return this.dir.provisionOuDn;
    return `${resolveOuRdn(ouRdn, this.dir.domainRoot)},${this.dir.domainRoot}`;
  }

  getDirectoryConfig(): AdDirectoryConfig {
    return this.dir;
  }

  /** Verify the provisioning OU exists before attempting user creates. */
  async validateProvisioningOu(ouRdn?: string): Promise<{
    ok: boolean;
    ouRdn: string;
    ouDn: string;
    suggestions: string[];
    inferredProvisionOu: boolean;
  }> {
    const normalized = ouRdn?.trim()
      ? resolveOuRdn(ouRdn, this.dir.domainRoot)
      : this.dir.provisionOuRdn;
    const ouDn = `${normalized},${this.dir.domainRoot}`;

    await this.ensureConnected();

    let ok = false;
    try {
      await this.client.search(ouDn, {
        scope:  'base',
        filter: '(objectClass=organizationalUnit)',
        attributes: ['dn'],
      });
      ok = true;
    } catch {
      ok = false;
    }

    const suggestions = ok ? [] : await this.listOrganizationalUnits(12);
    return {
      ok,
      ouRdn: normalized,
      ouDn,
      suggestions,
      inferredProvisionOu: this.dir.inferredProvisionOu,
    };
  }

  /** List organizational units under baseDn (full DNs). */
  async listOrganizationalUnits(max = 12): Promise<string[]> {
    await this.ensureConnected();
    try {
      const result = await this.client.search(this.baseDn, {
        scope:  'sub',
        filter: '(objectClass=organizationalUnit)',
        attributes: ['dn'],
        sizeLimit: max,
      });
      return (result.searchEntries as Array<{ dn?: string }>)
        .map((e) => e.dn ?? '')
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Search helper with auto-reconnect
  // ---------------------------------------------------------------------------
  private async searchAt(baseDn: string, filter: string, attributes: string[]): Promise<ADUser[]> {
    await this.ensureConnected();
    const run = () =>
      this.client.search(baseDn, {
        scope:      'sub',
        filter,
        attributes,
        sizeLimit:  2000,
      });
    try {
      const result = await run();
      return result.searchEntries as unknown as ADUser[];
    } catch (err) {
      this.connected = false;
      this.client = this.createClient();
      await this.connect();
      const result = await run();
      return result.searchEntries as unknown as ADUser[];
    }
  }

  private async search(filter: string, attributes: string[]): Promise<ADUser[]> {
    return this.searchAt(this.baseDn, filter, attributes);
  }

  // ---------------------------------------------------------------------------
  // BaseAdapter implementation
  // ---------------------------------------------------------------------------

  /** List person accounts under the LDAP search base (inbound directory import). */
  async listDirectoryUsers(): Promise<AdapterResult<ADUser[]>> {
    return this.safe(async () => {
      // '*' returns every non-operational user attribute, so a deployment can
      // store employee ID in any custom field (extensionAttribute5, pager,
      // description, lenskartEmpId, etc.) without us having to enumerate.
      const attrs = ['*'];
      // Simple filter — objectCategory form often returns 0 rows on some AD forests
      const filter = '(&(objectClass=user)(!(sAMAccountName=*$)))';

      const bases: string[] = [];
      for (const b of [this.dir.provisionOuDn, this.dir.searchBaseDn, this.dir.domainRoot]) {
        if (b && !bases.includes(b)) bases.push(b);
      }

      let rawEntries: ADUser[] = [];
      let usedBase = '';
      for (const base of bases) {
        const batch = await this.searchAt(base, filter, attrs);
        logger.info({ base, rawCount: batch.length }, 'AD listDirectoryUsers: LDAP search');
        if (batch.length > 0) {
          rawEntries = batch;
          usedBase = base;
          break;
        }
      }

      const users = rawEntries.filter((e) => {
        const sam = getLdapAttr(e, 'sAMAccountName');
        return sam.length > 0 && !sam.endsWith('$');
      });

      logger.info({ usedBase, rawCount: rawEntries.length, userCount: users.length }, 'AD listDirectoryUsers: filtered');
      return users;
    });
  }

  /**
   * Find an AD user by employeeID attribute (maps to emp_id in LILG).
   */
  async getUser(externalId: string): Promise<AdapterResult<UserInfo>> {
    return this.safe(async () => {
      const entries = await this.search(
        `(&(objectClass=user)(employeeID=${ldapEscape(externalId)}))`,
        ['dn', 'sAMAccountName', 'employeeID', 'mail', 'displayName', 'userAccountControl', 'memberOf', 'extensionAttribute1', 'extensionAttribute2'],
      );

      if (entries.length === 0) {
        throw new ADNotFoundError(`AD user not found for employeeID=${externalId}`);
      }

      return this.buildUserInfo(externalId, entries[0]);
    }, (err) => err instanceof ADNotFoundError);
  }

  /**
   * Find an AD user by their corporate email (mail attribute).
   * Used for reconciliation when employeeID is not yet set on existing accounts.
   */
  async getUserByEmail(email: string): Promise<AdapterResult<UserInfo>> {
    return this.safe(async () => {
      const entries = await this.search(
        `(&(objectClass=user)(|(mail=${ldapEscape(email)})(userPrincipalName=${ldapEscape(email)})))`,
        ['*'],
      );

      if (entries.length === 0) {
        throw new ADNotFoundError(`AD user not found for mail=${email}`);
      }

      const samName = String(entries[0].sAMAccountName ?? '');
      return this.buildUserInfo(samName, entries[0]);
    }, (err) => err instanceof ADNotFoundError);
  }

  /** Full LDAP entry by corporate email (all attributes) — used for emp_id resolution. */
  async getDirectoryEntryByEmail(email: string): Promise<AdapterResult<ADUser>> {
    return this.safe(async () => {
      const entries = await this.search(
        `(&(objectClass=user)(|(mail=${ldapEscape(email)})(userPrincipalName=${ldapEscape(email)})))`,
        ['*'],
      );

      if (entries.length === 0) {
        throw new ADNotFoundError(`AD user not found for mail=${email}`);
      }

      return entries[0];
    }, (err) => err instanceof ADNotFoundError);
  }

  private buildUserInfo(externalId: string, entry: ADUser): UserInfo {
    const uac = parseInt(entry.userAccountControl as string ?? '512', 10);
    const disabled = (uac & UAC_ACCOUNTDISABLE) !== 0;
    return {
      externalId,
      email:          (entry.mail as string | undefined) ?? '',
      displayName:    (entry.displayName as string | undefined) ?? (entry.sAMAccountName as string | undefined) ?? '',
      active:         !disabled,
      dn:             entry.dn,
      sAMAccountName: entry.sAMAccountName,
      uac,
      memberOf:       Array.isArray(entry.memberOf) ? entry.memberOf : entry.memberOf ? [entry.memberOf as string] : [],
    };
  }

  /** Resolve a user by sAMAccountName (identity_links external_id) or employeeID. */
  private async findUser(externalId: string, attributes: string[]): Promise<ADUser[]> {
    const bySam = await this.search(
      `(&(objectClass=user)(sAMAccountName=${ldapEscape(externalId)}))`,
      attributes,
    );
    if (bySam.length > 0) return bySam;

    return this.search(
      `(&(objectClass=user)(employeeID=${ldapEscape(externalId)}))`,
      attributes,
    );
  }

  /**
   * Disable: set userAccountControl to DISABLED (514) and move to Disabled OU.
   */
  async disable(externalId: string, _evidence?: Record<string, unknown>): Promise<AdapterResult<void>> {
    return this.safe(async () => {
      const entries = await this.findUser(externalId, ['dn', 'userAccountControl', 'extensionAttribute2']);

      if (entries.length === 0) {
        logger.warn({ externalId }, 'AD disable: user not found, treating as already removed');
        return;
      }

      const entry   = entries[0];
      const currentDn = entry.dn;

      await this.ensureConnected();

      // 1. Set userAccountControl = 514 (disabled)
      const uacChange = new Change({
        operation: 'replace',
        modification: new Attribute({
          type: 'userAccountControl',
          values: [String(UAC_DISABLED_ACCOUNT)],
        }),
      });
      await this.client.modify(currentDn, [uacChange]);

      // 2. Move to Disabled OU if not already there
      if (!currentDn.toUpperCase().includes(this.disabledOu.toUpperCase())) {
        const cn      = currentDn.split(',')[0];          // e.g. CN=John Doe
        const newRdn  = cn;
        const newSup  = `${this.disabledOu}${this.dir.domainRoot}`;
        await this.client.modifyDN(currentDn, `${newRdn},${newSup}`);
        logger.info({ externalId, newDn: `${newRdn},${newSup}` }, 'AD user moved to Disabled OU');
      }

      logger.info({ externalId }, 'AD user disabled');
    });
  }

  /**
   * Enable: set userAccountControl to NORMAL (512) and move back to target OU.
   * The target OU is stored in extensionAttribute2 by the provisioning process.
   */
  async enable(externalId: string): Promise<AdapterResult<void>> {
    return this.safe(async () => {
      const entries = await this.findUser(externalId, ['dn', 'userAccountControl', 'extensionAttribute2']);

      if (entries.length === 0) {
        logger.warn({ externalId }, 'AD enable: user not found');
        return;
      }

      const entry   = entries[0];
      const currentDn = entry.dn;

      await this.ensureConnected();

      // 1. Set userAccountControl = 512 (normal)
      const uacChange = new Change({
        operation: 'replace',
        modification: new Attribute({
          type: 'userAccountControl',
          values: [String(UAC_NORMAL_ACCOUNT)],
        }),
      });
      await this.client.modify(currentDn, [uacChange]);

      // 2. Move back to active OU when coming from Disabled OU
      const targetOu = (entry.extensionAttribute2 as string | undefined)
        || `${this.dir.provisionOuRdn},${this.dir.domainRoot}`;
      if (currentDn.toUpperCase().includes(this.disabledOu.toUpperCase())) {
        const cn     = currentDn.split(',')[0];
        const newRdn = cn;
        await this.client.modifyDN(currentDn, `${newRdn},${targetOu}`);
        logger.info({ externalId, targetOu }, 'AD user moved back to active OU');
      }

      logger.info({ externalId }, 'AD user enabled');
    });
  }

  /**
   * Delete: permanently remove from Active Directory.
   */
  async delete(externalId: string): Promise<AdapterResult<void>> {
    return this.safe(async () => {
      const entries = await this.findUser(externalId, ['dn']);

      if (entries.length === 0) {
        logger.warn({ externalId }, 'AD delete: user not found, treating as gone');
        return;
      }

      await this.ensureConnected();
      await this.client.del(entries[0].dn);
      logger.info({ externalId, dn: entries[0].dn }, 'AD user deleted');
    });
  }

  /**
   * AD does not have OAuth tokens; this is a no-op that logs a warning.
   * Kerberos TGTs expire naturally; AD admins can force a logout via GPO.
   */
  async revokeTokens(_externalId: string): Promise<AdapterResult<void>> {
    logger.warn({ system: 'AD' }, 'revokeTokens called on AD adapter — Kerberos TGTs expire naturally. Use disable() to block new authentications.');
    return { success: true, data: undefined };
  }

  /**
   * Resolve an AD group by CN, sAMAccountName, or distinguished name.
   */
  async findGroup(
    groupKey: string,
  ): Promise<AdapterResult<{ dn: string; name: string; mail?: string } | null>> {
    return this.safe(async () => {
      const key = groupKey.trim();
      if (!key) return null;

      if (key.includes('=') && key.includes(',')) {
        const baseEntries = await this.searchAt(key, '(objectClass=group)', ['dn', 'cn', 'mail', 'displayName']);
        if (baseEntries.length > 0) {
          const e = baseEntries[0];
          const mail = getLdapAttr(e, 'mail');
          return {
            dn:   e.dn,
            name: getLdapAttr(e, 'displayName') || getLdapAttr(e, 'cn') || key,
            ...(mail ? { mail } : {}),
          };
        }
      }

      const esc = key.replace(/[\\*()\\x00]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
      const filter = `(&(objectClass=group)(|(cn=${esc})(sAMAccountName=${esc})))`;
      const searchBases = [this.baseDn];
      if (this.dir.domainRoot.toUpperCase() !== this.baseDn.toUpperCase()) {
        searchBases.push(this.dir.domainRoot);
      }
      let entries: ADUser[] = [];
      for (const base of searchBases) {
        entries = await this.searchAt(base, filter, ['dn', 'cn', 'mail', 'displayName', 'sAMAccountName']);
        if (entries.length) break;
      }
      if (!entries.length) return null;

      const e = entries[0];
      const mail = getLdapAttr(e, 'mail');
      return {
        dn:   e.dn,
        name: getLdapAttr(e, 'displayName') || getLdapAttr(e, 'cn') || key,
        ...(mail ? { mail } : {}),
      };
    });
  }

  /**
   * List security groups under the domain root (for syncGroups = *).
   * Skips built-in domain groups; capped at 200.
   */
  async listDirectoryGroups(): Promise<AdapterResult<Array<{ dn: string; name: string; sam?: string }>>> {
    return this.safe(async () => {
      const skipCn = new Set([
        'domain users', 'domain computers', 'domain controllers',
        'domain admins', 'domain guests', 'group policy creator owners',
        'read-only domain controllers', 'cloneable domain controllers',
        'dnsadmins', 'enterprise admins', 'schema admins',
      ]);
      const filter = '(&(objectClass=group)(sAMAccountName=*))';
      const entries = await this.searchAt(
        this.dir.domainRoot,
        filter,
        ['dn', 'cn', 'displayName', 'sAMAccountName'],
      );
      const out: Array<{ dn: string; name: string; sam?: string }> = [];
      const seen = new Set<string>();
      for (const e of entries) {
        const dn = e.dn;
        if (!dn || seen.has(dn.toLowerCase())) continue;
        const cn = (getLdapAttr(e, 'cn') || '').toLowerCase();
        if (skipCn.has(cn)) continue;
        seen.add(dn.toLowerCase());
        const sam = getLdapAttr(e, 'sAMAccountName');
        const name = getLdapAttr(e, 'displayName') || getLdapAttr(e, 'cn') || sam || dn;
        const row: { dn: string; name: string; sam?: string } = { dn, name };
        if (sam) row.sam = sam;
        out.push(row);
        if (out.length >= 200) break;
      }
      return out;
    });
  }

  /** List enabled user members of a group (by group DN). */
  async listGroupMemberUsers(
    groupDn: string,
  ): Promise<AdapterResult<Array<{ sam: string; mail?: string }>>> {
    return this.safe(async () => {
      const groupEntries = await this.searchAt(groupDn, '(objectClass=group)', ['member']);
      if (!groupEntries.length) return [];

      const raw = groupEntries[0].member;
      const memberDns: string[] = Array.isArray(raw)
        ? (raw as string[])
        : (raw ? [String(raw)] : []);

      const users: Array<{ sam: string; mail?: string }> = [];
      for (const memberDn of memberDns.slice(0, 1000)) {
        try {
          const uEntries = await this.searchAt(
            memberDn,
            '(&(objectClass=user)(!(sAMAccountName=*$)))',
            ['sAMAccountName', 'mail', 'userAccountControl'],
          );
          if (!uEntries.length) continue;
          const u = uEntries[0];
          const uac = Number(getLdapAttr(u, 'userAccountControl') || '0');
          if (uac & UAC_ACCOUNTDISABLE) continue;
          const sam = getLdapAttr(u, 'sAMAccountName');
          if (!sam) continue;
          const mail = getLdapAttr(u, 'mail');
          const row: { sam: string; mail?: string } = { sam };
          if (mail) row.mail = mail;
          users.push(row);
        } catch {
          // skip unresolved member DNs (nested groups, contacts, etc.)
        }
      }
      return users;
    });
  }

  /**
   * List all AD security groups the user is a member of (via memberOf attribute).
   */
  async listBindings(externalId: string): Promise<AdapterResult<Binding[]>> {
    return this.safe(async () => {
      const entries = await this.findUser(externalId, ['memberOf']);

      if (entries.length === 0) {
        return [];
      }

      const raw = entries[0].memberOf;
      const memberOf: string[] = Array.isArray(raw) ? raw as string[] : (raw ? [raw as string] : []);

      const bindings: Binding[] = memberOf.map((dn) => {
        const cn = dn.split(',')[0].replace(/^CN=/i, '');
        return { id: dn, name: cn, type: 'AD_GROUP', scope: dn };
      });

      return bindings;
    });
  }

  /**
   * Provision a new user in Active Directory with all LILG-managed attributes.
   */
  async createUser(params: {
    empId: string;
    fullName: string;
    emailCorp: string;
    sAMAccountName: string;
    department: string;
    title: string;
    targetOu: string;
    upnDomain?: string;
    manager?: string;
    tempPassword: string;
  }): Promise<AdapterResult<void>> {
    return this.safe(async () => {
      await this.ensureConnected();

      if (!this.connectionIsSecure()) {
        throw new Error(
          'AD user provisioning requires LDAPS (port 636) or LDAP+StartTLS — set Protocol in connector config',
        );
      }

      const sam = sanitizeSamAccountName(params.sAMAccountName);
      const cn = escapeRdnValue(sam);
      const ou = params.targetOu.trim()
        ? resolveOuRdn(params.targetOu.trim(), this.dir.domainRoot)
        : this.dir.provisionOuRdn;
      const dn = `CN=${cn},${ou},${this.dir.domainRoot}`;
      const upnDomain = params.upnDomain?.trim() || domainFromBaseDn(this.dir.domainRoot);
      const userPrincipalName = `${sam}@${upnDomain}`.toLowerCase();

      const existing = await this.findUser(sam, ['dn']);
      if (existing.length > 0) {
        throw new Error(`sAMAccountName '${sam}' already exists in AD (${existing[0].dn})`);
      }

      const nameParts = params.fullName.trim().split(/\s+/).filter(Boolean);
      const givenName = sanitizeAdString(nameParts[0] ?? sam, 64);
      const sn = sanitizeAdString(nameParts.length > 1 ? nameParts.slice(1).join(' ') : givenName, 64);

      const entry: Record<string, string | string[]> = {
        objectClass:        ['top', 'person', 'organizationalPerson', 'user'],
        cn:                  sam,
        sAMAccountName:      sam,
        userPrincipalName,
        mail:                params.emailCorp.trim().toLowerCase(),
        displayName:         sanitizeAdString(params.fullName, 256),
        givenName,
        sn,
        employeeID:          params.empId,
        // Create disabled; password is set via a separate modify (AD rejects unicodePwd on add)
        userAccountControl:  String(UAC_DISABLED_ACCOUNT),
      };

      if (params.department.trim()) {
        entry['department'] = sanitizeAdString(params.department.trim(), 64);
      }
      if (params.title.trim()) {
        entry['title'] = sanitizeAdString(params.title.trim(), 128);
      }
      if (params.manager) {
        entry['manager'] = params.manager;
      }

      logger.info({ empId: params.empId, dn, userPrincipalName }, 'AD createUser: adding entry');

      try {
        await this.client.add(dn, entry);

        // Step 2 — set password over encrypted connection
        await this.client.modify(dn, [
          new Change({
            operation: 'replace',
            modification: new Attribute({
              type: 'unicodePwd',
              values: [encodeAdPassword(params.tempPassword)],
            }),
          }),
        ]);

        // Step 3 — enable and force password change on first logon
        await this.client.modify(dn, [
          new Change({
            operation: 'replace',
            modification: new Attribute({
              type: 'userAccountControl',
              values: [String(UAC_NORMAL_ACCOUNT)],
            }),
          }),
          new Change({
            operation: 'replace',
            modification: new Attribute({
              type: 'pwdLastSet',
              values: ['0'],
            }),
          }),
        ]);
      } catch (err) {
        // Roll back a partially created entry so the next sync can retry cleanly
        try { await this.client.del(dn); } catch { /* best effort */ }
        throw new Error(formatLdapError(err));
      }

      logger.info({ empId: params.empId, dn, userPrincipalName }, 'AD user created');
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
class ADNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ADNotFoundError';
  }
}

/** Read an LDAP entry attribute (case-insensitive; handles array values from ldapts). */
export function getLdapAttr(entry: Record<string, unknown>, name: string): string {
  if (name.toLowerCase() === 'dn') {
    return entry['dn'] != null ? String(entry['dn']) : '';
  }
  const key = Object.keys(entry).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!key) return '';
  const val = entry[key];
  if (Array.isArray(val)) return val[0] != null ? String(val[0]) : '';
  if (Buffer.isBuffer(val)) return val.toString('utf8');
  return val != null ? String(val) : '';
}

/** True when a string looks like a usable Lenskart employee id (not a hash placeholder). */
function isValidAdEmpId(value: string): boolean {
  const v = value.trim();
  if (!v || v.length > 20) return false;
  if (/^AD-[A-F0-9]{8,}$/i.test(v)) return false;
  return /^[A-Za-z0-9._-]+$/.test(v);
}

/** Pull LSP##### (or similar) codes embedded in display names. */
function extractEmpIdFromText(text: string): string {
  const lsp = text.match(/\b(LSP\d{4,8})\b/i);
  if (lsp?.[1]) return lsp[1].toUpperCase();
  return '';
}

/**
 * Resolve the canonical employee id from an AD LDAP entry.
 * Order: employeeID → employeeNumber → extensionAttribute* → pager/description → displayName/cn.
 */
export function readAdEmployeeId(adUser: Record<string, unknown>): string {
  const priorityAttrs = [
    'employeeID', 'employeeNumber',
    'extensionAttribute1', 'extensionAttribute2', 'extensionAttribute3',
    'extensionAttribute4', 'extensionAttribute5', 'extensionAttribute6',
    'extensionAttribute7', 'extensionAttribute8', 'extensionAttribute9',
    'extensionAttribute10', 'extensionAttribute11', 'extensionAttribute12',
    'extensionAttribute13', 'extensionAttribute14', 'extensionAttribute15',
    'pager', 'initials', 'info', 'description',
  ];

  for (const attr of priorityAttrs) {
    const v = getLdapAttr(adUser, attr).trim();
    if (isValidAdEmpId(v)) return v;
  }

  for (const key of Object.keys(adUser)) {
    const kl = key.toLowerCase();
    if (kl === 'dn' || kl === 'objectclass' || kl.includes('guid') || kl.includes('sid')) continue;
    if (!kl.includes('employee') && !kl.startsWith('extensionattribute') && kl !== 'pager' && kl !== 'description') {
      continue;
    }
    const v = getLdapAttr(adUser, key).trim();
    if (isValidAdEmpId(v)) return v;
  }

  for (const attr of ['displayName', 'cn', 'name']) {
    const parsed = extractEmpIdFromText(getLdapAttr(adUser, attr));
    if (parsed) return parsed;
  }

  return '';
}

/** Build a clean full name without trailing employee-id tokens (e.g. "Hemant Sharma LSP01649"). */
export function cleanAdDisplayName(adUser: Record<string, unknown>, fallback = ''): string {
  let name =
    getLdapAttr(adUser, 'displayName')
    || [getLdapAttr(adUser, 'givenName'), getLdapAttr(adUser, 'sn')].filter(Boolean).join(' ')
    || getLdapAttr(adUser, 'cn')
    || fallback;

  const empId = readAdEmployeeId(adUser);
  if (empId) {
    name = name.replace(new RegExp(`\\s*${empId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'), '').trim();
  }
  name = name.replace(/\s+LSP\d{4,8}\s*$/i, '').trim();
  return name || fallback;
}

/** Split a DN into domain root (DC=…) and any OU= prefix. */
export function splitDomainRoot(baseDn: string): { domainRoot: string; ouPrefix: string | null } {
  const parts = baseDn.split(',').map((p) => p.trim()).filter(Boolean);
  const dcParts = parts.filter((p) => /^DC=/i.test(p));
  const ouParts = parts.filter((p) => /^OU=/i.test(p));
  return {
    domainRoot: dcParts.join(','),
    ouPrefix: ouParts.length > 0 ? ouParts.join(',') : null,
  };
}

/**
 * Resolve connector Base DN + optional New User OU into search/provision paths.
 * If New User OU is blank but Base DN is an OU (e.g. OU=IT,DC=…), that OU is used.
 */
export function resolveAdDirectoryConfig(baseDn: string, targetOuRaw?: string): AdDirectoryConfig {
  const searchBaseDn = baseDn.trim();
  if (!searchBaseDn) {
    throw new Error('Base DN is required (e.g. DC=Lenskart,DC=in)');
  }

  const { domainRoot, ouPrefix } = splitDomainRoot(searchBaseDn);
  const root = domainRoot || searchBaseDn;

  let provisionOuRdn: string;
  let inferredProvisionOu = false;

  if (targetOuRaw?.trim()) {
    provisionOuRdn = resolveOuRdn(targetOuRaw.trim(), root);
  } else if (ouPrefix) {
    provisionOuRdn = ouPrefix;
    inferredProvisionOu = true;
  } else {
    throw new Error(
      'New User OU is not set. Enter where new accounts should be created (e.g. OU=IT). ' +
      'Base DN should be the domain root (DC=Lenskart,DC=in), not the OU itself.',
    );
  }

  return {
    searchBaseDn,
    domainRoot: root,
    provisionOuRdn,
    provisionOuDn: `${provisionOuRdn},${root}`,
    inferredProvisionOu,
  };
}

/** Resolve a user-supplied OU to an RDN path relative to the domain root. */
export function resolveOuRdn(raw: string | undefined, baseDn: string): string {
  let v = (raw ?? '').trim();
  if (!v) {
    throw new Error('New User OU is required — set it in connector config (e.g. OU=IT)');
  }

  // User pasted a full DN — strip the base suffix so we store only the relative OU path
  const suffix = `,${baseDn}`;
  if (v.toUpperCase().endsWith(suffix.toUpperCase())) {
    v = v.slice(0, v.length - suffix.length);
  }

  // Already one or more OU= components — use exactly as given (comma-separated relative path)
  if (/^OU=/i.test(v)) {
    return v.split(',').map((part) => part.trim()).filter(Boolean).join(',');
  }

  // Bare name without OU= prefix, e.g. "IT" → "OU=IT"
  if (!v.includes(',')) {
    return `OU=${v}`;
  }

  // Mixed segments — prefix each part that lacks OU=
  return v.split(',').map((part) => {
    const t = part.trim();
    return /^OU=/i.test(t) ? t : `OU=${t}`;
  }).filter(Boolean).join(',');
}

/** @deprecated use resolveOuRdn */
export function normalizeOuRdn(value: string): string {
  const v = value.trim();
  if (!v) return '';
  if (/^OU=/i.test(v)) return v;
  return `OU=${v}`;
}

/** Escape special characters in LDAP filter values (RFC 4515) */
function ldapEscape(value: string): string {
  return value.replace(/[\\*()\x00/]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/** Escape RDN attribute values (RFC 4514) — commas in display names break CN= DNs. */
function escapeRdnValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/,/g, '\\,')
    .replace(/\+/g, '\\+')
    .replace(/"/g, '\\"')
    .replace(/</g, '\\<')
    .replace(/>/g, '\\>')
    .replace(/;/g, '\\;')
    .replace(/^ /, '\\ ')
    .replace(/ $/, '\\ ');
}

/** Derive DNS-style domain from base DN, e.g. DC=lenskart,DC=local → lenskart.local */
function domainFromBaseDn(baseDn: string): string {
  return baseDn
    .split(',')
    .map((part) => part.trim())
    .filter((part) => /^DC=/i.test(part))
    .map((part) => part.slice(3))
    .join('.');
}

/** Strip control chars and enforce AD string length limits. */
function sanitizeAdString(value: string, maxLen: number): string {
  return value.replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, maxLen);
}

/** Enforce sAMAccountName rules: max 20 chars, no trailing dot. */
function sanitizeSamAccountName(value: string): string {
  let sam = value.toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/^\.+|\.+$/g, '');
  if (!sam) sam = 'user';
  return sam.slice(0, 20);
}

/** Format ldapts / AD LDAP errors for operator-readable sync logs. */
function formatLdapError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const extra = err as Error & { code?: unknown; lde_message?: string };
  const bits = [err.message];
  if (extra.lde_message && extra.lde_message !== err.message) bits.push(extra.lde_message);
  if (extra.code !== undefined) bits.push(`code=${String(extra.code)}`);
  const text = bits.join(' — ');
  if (extra.code === 32 || text.includes('NO_OBJECT') || text.includes('0000208D')) {
    return `${text} — the target OU path does not exist; set "New User OU" to an existing OU under Base DN`;
  }
  return text;
}

/** Encode a plain-text password for the AD unicodePwd attribute (UTF-16LE, quoted) */
function encodeAdPassword(password: string): Buffer {
  return Buffer.from(`"${password}"`, 'utf16le');
}
