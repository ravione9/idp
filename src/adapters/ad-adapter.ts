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

// ---------------------------------------------------------------------------
// ADAdapter
// ---------------------------------------------------------------------------
export class ADAdapter extends BaseAdapter {
  private client: Client;
  private connected = false;

  constructor(
    redis: Redis,
    private readonly url: string,
    private readonly bindDn: string,
    private readonly bindPassword: string,
    private readonly baseDn: string,
    private readonly disabledOu = 'OU=Disabled,',
    private readonly startTls = false,
    private readonly provisionOu = 'OU=Employees',
  ) {
    super(redis, 'AD', { minRequests: 10, errorThreshold: 75 });
    this.client = this.createClient();
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

  /** Build full DN for an OU RDN relative to baseDn. */
  buildOuDn(ouRdn: string): string {
    return `${normalizeOuRdn(ouRdn)},${this.baseDn}`;
  }

  /** Verify the provisioning OU exists before attempting user creates. */
  async validateProvisioningOu(ouRdn?: string): Promise<{
    ok: boolean;
    ouRdn: string;
    ouDn: string;
    suggestions: string[];
  }> {
    const normalized = normalizeOuRdn(ouRdn?.trim() || this.provisionOu);
    const ouDn = `${normalized},${this.baseDn}`;
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
    return { ok, ouRdn: normalized, ouDn, suggestions };
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
  private async search(filter: string, attributes: string[]): Promise<ADUser[]> {
    await this.ensureConnected();
    try {
      const result = await this.client.search(this.baseDn, {
        scope:  'sub',
        filter,
        attributes,
      });
      return result.searchEntries as unknown as ADUser[];
    } catch (err) {
      // Try to reconnect once on LDAP connection errors
      this.connected = false;
      this.client = this.createClient();
      await this.connect();
      const result = await this.client.search(this.baseDn, {
        scope:  'sub',
        filter,
        attributes,
      });
      return result.searchEntries as unknown as ADUser[];
    }
  }

  // ---------------------------------------------------------------------------
  // BaseAdapter implementation
  // ---------------------------------------------------------------------------

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
        `(&(objectClass=user)(mail=${ldapEscape(email)}))`,
        ['dn', 'sAMAccountName', 'employeeID', 'mail', 'displayName', 'userAccountControl', 'memberOf', 'extensionAttribute1', 'extensionAttribute2'],
      );

      if (entries.length === 0) {
        throw new ADNotFoundError(`AD user not found for mail=${email}`);
      }

      const samName = String(entries[0].sAMAccountName ?? '');
      return this.buildUserInfo(samName, entries[0]);
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
        const newSup  = `${this.disabledOu}${this.baseDn}`;
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
        || `${this.provisionOu},${this.baseDn}`;
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
      const ou = normalizeOuRdn(params.targetOu.trim() || this.provisionOu);
      const dn = `CN=${cn},${ou},${this.baseDn}`;
      const upnDomain = params.upnDomain?.trim() || domainFromBaseDn(this.baseDn);
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

/** Accept "IT" or "OU=IT" and return a proper OU RDN. */
export function normalizeOuRdn(value: string): string {
  const v = value.trim();
  if (!v) return 'OU=Employees';
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
