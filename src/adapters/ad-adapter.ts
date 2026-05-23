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
  ) {
    super(redis, 'AD');
    this.client = this.createClient();
  }

  // ---------------------------------------------------------------------------
  // Connection management
  // ---------------------------------------------------------------------------
  private createClient(): Client {
    return new Client({
      url:              this.url,
      connectTimeout:   10_000,
      timeout:          15_000,
      tlsOptions:       { rejectUnauthorized: process.env['NODE_ENV'] === 'production' },
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    try {
      await this.client.bind(this.bindDn, this.bindPassword);
      this.connected = true;
      logger.info({ url: this.url }, 'AD: LDAP bind successful');
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

      const entry = entries[0];
      const uac = parseInt(entry.userAccountControl as string ?? '512', 10);
      const disabled = (uac & UAC_ACCOUNTDISABLE) !== 0;

      return {
        externalId,
        email:       (entry.mail as string | undefined) ?? '',
        displayName: (entry.displayName as string | undefined) ?? (entry.sAMAccountName as string | undefined) ?? '',
        active:      !disabled,
        dn:          entry.dn,
        sAMAccountName: entry.sAMAccountName,
        uac,
        memberOf:    Array.isArray(entry.memberOf) ? entry.memberOf : entry.memberOf ? [entry.memberOf as string] : [],
      };
    });
  }

  /**
   * Disable: set userAccountControl to DISABLED (514) and move to Disabled OU.
   */
  async disable(externalId: string, _evidence?: Record<string, unknown>): Promise<AdapterResult<void>> {
    return this.safe(async () => {
      const entries = await this.search(
        `(&(objectClass=user)(employeeID=${ldapEscape(externalId)}))`,
        ['dn', 'userAccountControl', 'extensionAttribute2'],
      );

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
      const entries = await this.search(
        `(&(objectClass=user)(employeeID=${ldapEscape(externalId)}))`,
        ['dn', 'userAccountControl', 'extensionAttribute2'],
      );

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

      // 2. Move back to original OU if extensionAttribute2 is set
      const targetOu = (entry.extensionAttribute2 as string | undefined);
      if (targetOu && currentDn.toUpperCase().includes(this.disabledOu.toUpperCase())) {
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
      const entries = await this.search(
        `(&(objectClass=user)(employeeID=${ldapEscape(externalId)}))`,
        ['dn'],
      );

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
      const entries = await this.search(
        `(&(objectClass=user)(employeeID=${ldapEscape(externalId)}))`,
        ['memberOf'],
      );

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
    manager?: string;
    tempPassword: string;
  }): Promise<AdapterResult<void>> {
    return this.safe(async () => {
      await this.ensureConnected();

      const dn = `CN=${params.fullName},${params.targetOu},${this.baseDn}`;

      const entry: Record<string, string | string[]> = {
        objectClass:        ['top', 'person', 'organizationalPerson', 'user'],
        cn:                  params.fullName,
        sAMAccountName:      params.sAMAccountName,
        userPrincipalName:   params.emailCorp,
        mail:                params.emailCorp,
        displayName:         params.fullName,
        employeeID:          params.empId,
        department:          params.department,
        title:               params.title,
        // Store the target OU for re-enable after disable
        extensionAttribute2: `${params.targetOu},${this.baseDn}`,
        userAccountControl:  String(UAC_NORMAL_ACCOUNT),
        unicodePwd:          encodeAdPassword(params.tempPassword),
        pwdLastSet:          '0', // Force password change on next logon
      };

      if (params.manager) {
        entry['manager'] = params.manager;
      }

      await this.client.add(dn, entry as Record<string, string[]>);
      logger.info({ empId: params.empId, dn }, 'AD user created');
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

/** Escape special characters in LDAP filter values (RFC 4515) */
function ldapEscape(value: string): string {
  return value.replace(/[\\*()\x00/]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/** Encode a plain-text password for the AD unicodePwd attribute */
function encodeAdPassword(password: string): string {
  const quoted = `"${password}"`;
  const buf = Buffer.from(quoted, 'utf16le');
  return buf.toString('binary');
}
