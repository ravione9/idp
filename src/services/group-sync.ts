/**
 * Directory group sync — mirror Google Workspace / AD groups into `groups` + `group_members`.
 */

import { v4 as uuidv4 } from 'uuid';
import { google } from 'googleapis';
import type { admin_directory_v1 } from 'googleapis';
import { query, queryOne, execute } from '../db/connection.js';
import { ADAdapter } from '../adapters/ad-adapter.js';
import { redis } from '../auth/session-store.js';
import { connectAdAdapterWithFallback } from './ad-ldap-connect.js';
import {
  buildGoogleJwtAuth,
  normalizeConnectorDirection,
  resolveGoogleSyncScope,
  parseCsvList,
  isGoogleGroupSyncAll,
  type GoogleSyncScope,
} from './google-directory-config.js';
import logger from '../utils/logger.js';

let groupSyncSchemaReady: boolean | null = null;

export async function isGroupSyncSchemaReady(): Promise<boolean> {
  if (groupSyncSchemaReady !== null) return groupSyncSchemaReady;
  try {
    // Probe the live table — avoids information_schema permission quirks and
    // matches what the extended list query actually needs.
    await query(`SELECT source_system FROM \`groups\` LIMIT 0`, []);
    groupSyncSchemaReady = true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ER_BAD_FIELD_ERROR' || code === 'ER_NO_SUCH_TABLE') {
      groupSyncSchemaReady = false;
    } else {
      logger.warn({ err }, 'Group sync schema probe failed — treating as not ready');
      groupSyncSchemaReady = false;
    }
  }
  return groupSyncSchemaReady;
}

export interface GroupSyncSummary {
  groupsSynced: number;
  membersSynced: number;
  errors: string[];
}

async function upsertSyncedGroup(params: {
  name: string;
  sourceSystem: 'GOOGLE' | 'AD';
  externalId: string;
  connectorId: string;
  description?: string | null;
}): Promise<string> {
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM \`groups\`
      WHERE source_system = ? AND external_id = ? AND connector_id = ?`,
    [params.sourceSystem, params.externalId, params.connectorId],
  );
  if (existing) {
    await execute(
      `UPDATE \`groups\` SET name = ?, description = ?, active = 1, last_synced_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP()
       WHERE id = ?`,
      [params.name, params.description ?? null, existing.id],
    );
    return existing.id;
  }

  const byName = await queryOne<{ id: string; source_system: string }>(
    `SELECT id, source_system FROM \`groups\` WHERE name = ?`,
    [params.name],
  );
  if (byName && byName.source_system === 'LOCAL') {
    await execute(
      `UPDATE \`groups\` SET source_system = ?, external_id = ?, connector_id = ?,
              type = 'STATIC', last_synced_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP()
       WHERE id = ?`,
      [params.sourceSystem, params.externalId, params.connectorId, byName.id],
    );
    return byName.id;
  }
  if (byName && byName.source_system === params.sourceSystem) {
    await execute(
      `UPDATE \`groups\` SET
          external_id = ?, connector_id = ?, active = 1, last_synced_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP()
       WHERE id = ?`,
      [params.externalId, params.connectorId, byName.id],
    );
    return byName.id;
  }

  const id = uuidv4();
  await execute(
    `INSERT INTO \`groups\`
       (id, name, description, type, source_system, external_id, connector_id, last_synced_at, active)
     VALUES (?, ?, ?, 'STATIC', ?, ?, ?, UTC_TIMESTAMP(), 1)`,
    [id, params.name, params.description ?? null, params.sourceSystem, params.externalId, params.connectorId],
  );
  return id;
}

async function replaceGroupMembers(groupId: string, empIds: string[]): Promise<number> {
  await execute(`DELETE FROM group_members WHERE group_id = ?`, [groupId]);
  let added = 0;
  for (const empId of empIds) {
    const exists = await queryOne<{ emp_id: string }>(
      `SELECT emp_id FROM employees WHERE emp_id = ?`,
      [empId],
    );
    if (!exists) continue;
    await execute(
      `INSERT IGNORE INTO group_members (group_id, emp_id, added_by) VALUES (?, ?, NULL)`,
      [groupId, empId],
    );
    added++;
  }
  return added;
}

async function resolveEmpIdByEmail(email: string): Promise<string | null> {
  if (!email) return null;
  const row = await queryOne<{ emp_id: string }>(
    `SELECT emp_id FROM employees WHERE LOWER(email_corp) = LOWER(?)`,
    [email.trim()],
  );
  return row?.emp_id ?? null;
}

async function resolveEmpIdByGoogleId(googleId: string, email: string): Promise<string | null> {
  const link = await queryOne<{ emp_id: string }>(
    `SELECT emp_id FROM identity_links WHERE \`system\` = 'GOOGLE' AND external_id = ? AND status != 'DELETED'`,
    [googleId],
  );
  if (link) return link.emp_id;
  return resolveEmpIdByEmail(email);
}

async function resolveEmpIdByAdSam(sam: string, email?: string): Promise<string | null> {
  const link = await queryOne<{ emp_id: string }>(
    `SELECT emp_id FROM identity_links WHERE \`system\` = 'AD' AND external_id = ? AND status != 'DELETED'`,
    [sam],
  );
  if (link) return link.emp_id;
  if (email) return resolveEmpIdByEmail(email);
  return null;
}

async function resolveEmpIdByAdMember(member: {
  sam: string;
  mail?: string | undefined;
  upn?: string | undefined;
  employeeId?: string | undefined;
}): Promise<string | null> {
  if (member.employeeId) {
    const byEmp = await queryOne<{ emp_id: string }>(
      `SELECT emp_id FROM employees WHERE emp_id = ?`,
      [member.employeeId.trim()],
    );
    if (byEmp) return byEmp.emp_id;
  }
  const email = member.mail || member.upn;
  return resolveEmpIdByAdSam(member.sam, email);
}

async function listGoogleDirectoryGroupEmails(
  directory: admin_directory_v1.Admin,
): Promise<{ emails: string[]; error?: string }> {
  const emails: string[] = [];
  let pageToken: string | undefined;
  try {
    do {
      const res = await directory.groups.list({
        // Multi-domain tenants: my_customer returns groups across all hosted domains.
        customer: 'my_customer',
        maxResults: 200,
        ...(pageToken ? { pageToken } : {}),
      });
      for (const g of res.data.groups ?? []) {
        const email = (g.email ?? '').trim().toLowerCase();
        if (!email) continue;
        emails.push(email);
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return { emails };
  } catch (err) {
    return {
      emails: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function resolveGoogleGroupKeys(
  directory: admin_directory_v1.Admin,
  scope: GoogleSyncScope,
  cfg?: Record<string, unknown>,
): Promise<{ keys: string[]; errors: string[]; autoAll: boolean }> {
  const autoAll = cfg ? isGoogleGroupSyncAll(cfg) : scope.groups.length === 0;
  if (!autoAll) {
    return { keys: scope.groups, errors: [], autoAll: false };
  }

  const listed = await listGoogleDirectoryGroupEmails(directory);
  if (listed.error) {
    return { keys: [], errors: [listed.error], autoAll: true };
  }
  if (!listed.emails.length) {
    return {
      keys: [],
      errors: ['No Google Workspace groups found (check group.readonly domain-wide delegation)'],
      autoAll: true,
    };
  }
  return { keys: listed.emails, errors: [], autoAll: true };
}

export async function syncGoogleDirectoryGroups(
  connectorId: string,
  directory: admin_directory_v1.Admin,
  scope: GoogleSyncScope,
  cfg?: Record<string, unknown>,
  opts: { onProgress?: (detail: string) => void | Promise<void> } = {},
): Promise<GroupSyncSummary & { autoAll: boolean }> {
  const summary: GroupSyncSummary & { autoAll: boolean } = {
    groupsSynced: 0,
    membersSynced: 0,
    errors: [],
    autoAll: false,
  };

  const resolved = await resolveGoogleGroupKeys(directory, scope, cfg);
  summary.autoAll = resolved.autoAll;
  summary.errors.push(...resolved.errors);
  const groupKeys = resolved.keys;
  if (!groupKeys.length) return summary;

  const syncMembers = scope.syncGroupMemberships !== false;
  let groupIndex = 0;

  for (const groupEmail of groupKeys) {
    groupIndex++;
    if (opts.onProgress && (groupIndex === 1 || groupIndex % 10 === 0 || groupIndex === groupKeys.length)) {
      await opts.onProgress(`${groupIndex} / ${groupKeys.length} groups`);
    }
    try {
      const gRes = await directory.groups.get({ groupKey: groupEmail });
      const g = gRes.data;
      const externalId = (g.email ?? groupEmail).toLowerCase();
      const name = g.name ?? externalId;
      const groupId = await upsertSyncedGroup({
        name,
        sourceSystem: 'GOOGLE',
        externalId,
        connectorId,
        description: `Synced from Google Workspace (${externalId})`,
      });
      summary.groupsSynced++;

      if (!syncMembers) continue;

      const empIds: string[] = [];
      let pageToken: string | undefined;
      do {
        const mRes = await directory.members.list({
          groupKey: externalId,
          maxResults: 200,
          ...(pageToken ? { pageToken } : {}),
        });
        for (const m of mRes.data.members ?? []) {
          if (m.type !== 'USER' || !m.email) continue;
          const empId = await resolveEmpIdByGoogleId(m.id ?? m.email, m.email)
            ?? await resolveEmpIdByEmail(m.email);
          if (empId) empIds.push(empId);
        }
        pageToken = mRes.data.nextPageToken ?? undefined;
      } while (pageToken);

      summary.membersSynced += await replaceGroupMembers(groupId, [...new Set(empIds)]);
    } catch (err) {
      summary.errors.push(`${groupEmail}: ${err instanceof Error ? err.message : String(err)}`);
      logger.warn({ groupEmail, err }, 'Google group sync failed');
    }
  }

  return summary;
}

async function resolveAdGroupKeys(
  adapter: ADAdapter,
  cfg: Record<string, unknown>,
): Promise<{ keys: string[]; errors: string[] }> {
  const raw = parseCsvList(cfg['syncGroups']);
  // Default behavior: if Sync Groups is empty, sync all security groups.
  // This avoids a common "AD group sync did nothing" misconfiguration.
  if (!raw.length) {
    const listed = await adapter.listDirectoryGroups();
    if (!listed.success) {
      return { keys: [], errors: [listed.error ?? 'failed to list AD security groups'] };
    }
    const dns = (listed.data ?? []).map((g) => g.dn);
    if (!dns.length) {
      return { keys: [], errors: ['No AD security groups found under domain root'] };
    }
    return { keys: dns, errors: [] };
  }

  const wildcard = raw.length === 1 && (raw[0] === '*' || raw[0].toUpperCase() === 'ALL');
  if (!wildcard) return { keys: raw, errors: [] };

  const listed = await adapter.listDirectoryGroups();
  if (!listed.success) {
    return { keys: [], errors: [listed.error ?? 'failed to list AD security groups'] };
  }
  const dns = (listed.data ?? []).map((g) => g.dn);
  if (!dns.length) {
    return { keys: [], errors: ['No AD security groups found under domain root'] };
  }
  return { keys: dns, errors: [] };
}

export interface AdAgentGroupPayload {
  dn: string;
  name: string;
  sam?: string | undefined;
  members: Array<{ sam: string; mail?: string | undefined; upn?: string | undefined; employeeId?: string | undefined }>;
}

/** Apply AD group membership snapshot posted by the on-prem agent. */
export async function processAdGroupsFromAgent(
  connectorId: string,
  groups: AdAgentGroupPayload[],
): Promise<GroupSyncSummary> {
  const summary: GroupSyncSummary = { groupsSynced: 0, membersSynced: 0, errors: [] };

  if (!(await isGroupSyncSchemaReady())) {
    summary.errors.push('Migration 014 not applied — restart API after deploy');
    return summary;
  }

  for (const g of groups) {
    try {
      if (!g.dn?.trim()) {
        summary.errors.push(`${g.name || '?'}: missing group DN`);
        continue;
      }
      const groupId = await upsertSyncedGroup({
        name: g.name || g.dn,
        sourceSystem: 'AD',
        externalId: g.dn,
        connectorId,
        description: `Synced from Active Directory (${g.dn})`,
      });
      summary.groupsSynced++;

      const empIds: string[] = [];
      for (const m of g.members ?? []) {
        const empId = await resolveEmpIdByAdMember(m);
        if (empId) empIds.push(empId);
      }
      summary.membersSynced += await replaceGroupMembers(groupId, [...new Set(empIds)]);
    } catch (err) {
      summary.errors.push(`${g.dn || g.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return summary;
}

export async function syncAdDirectoryGroups(
  connectorId: string,
  cfg: Record<string, unknown>,
  sharedAdapter?: ADAdapter,
): Promise<GroupSyncSummary> {
  const summary: GroupSyncSummary = { groupsSynced: 0, membersSynced: 0, errors: [] };
  const ownsAdapter = !sharedAdapter;
  let adapter = sharedAdapter;

  try {
    if (!adapter) {
      const connected = await connectAdAdapterWithFallback(redis, cfg);
      adapter = connected.adapter;
    } else {
      await adapter.refreshConnection();
    }

    const resolved = await resolveAdGroupKeys(adapter, cfg);
    summary.errors.push(...resolved.errors);
    const groupKeys = resolved.keys;
    if (!groupKeys.length) return summary;

    for (const groupKey of groupKeys) {
      try {
        const groupRes = await adapter.findGroup(groupKey);
        if (!groupRes.success || !groupRes.data) {
          summary.errors.push(`${groupKey}: group not found in AD`);
          continue;
        }
        const g = groupRes.data;
        const groupId = await upsertSyncedGroup({
          name: g.name,
          sourceSystem: 'AD',
          externalId: g.dn,
          connectorId,
          description: `Synced from Active Directory (${g.dn})`,
        });
        summary.groupsSynced++;

        const membersRes = await adapter.listGroupMemberUsers(g.dn);
        if (!membersRes.success) {
          summary.errors.push(`${groupKey}: ${membersRes.error ?? 'failed to list members'}`);
          continue;
        }

        const empIds: string[] = [];
        for (const m of membersRes.data ?? []) {
          const empId = await resolveEmpIdByAdMember(m);
          if (empId) empIds.push(empId);
        }
        summary.membersSynced += await replaceGroupMembers(groupId, [...new Set(empIds)]);
      } catch (err) {
        summary.errors.push(`${groupKey}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    summary.errors.push(`AD group sync: ${msg}`);
    logger.warn({ connectorId, err }, 'AD group sync failed');
  } finally {
    if (ownsAdapter && adapter) {
      await adapter.disconnect().catch(() => undefined);
    }
  }

  return summary;
}

export async function syncAllDirectoryGroups(): Promise<GroupSyncSummary> {
  if (!(await isGroupSyncSchemaReady())) {
    return {
      groupsSynced: 0,
      membersSynced: 0,
      errors: ['Migration 014 not applied — restart API after deploy'],
    };
  }

  const connectors = await query<{
    id: string;
    connector_type: string;
    config_json: string | Record<string, unknown>;
    direction: string;
  }>(
    `SELECT id, connector_type, config_json, direction FROM connectors
      WHERE status IN ('CONNECTED', 'ACTIVE')`,
    [],
  );

  const total: GroupSyncSummary = { groupsSynced: 0, membersSynced: 0, errors: [] };

  for (const conn of connectors) {
    const cfg: Record<string, unknown> =
      typeof conn.config_json === 'string'
        ? JSON.parse(conn.config_json || '{}') as Record<string, unknown>
        : (conn.config_json ?? {});

    if (conn.connector_type === 'GOOGLE' || conn.connector_type === 'GOOGLE_WORKSPACE') {
      const scope = resolveGoogleSyncScope(cfg);
      try {
        const auth = buildGoogleJwtAuth(cfg, normalizeConnectorDirection(conn.direction));
        const directory = google.admin({ version: 'directory_v1', auth });
        const part = await syncGoogleDirectoryGroups(conn.id, directory, scope, cfg);
        total.groupsSynced += part.groupsSynced;
        total.membersSynced += part.membersSynced;
        total.errors.push(...part.errors);
      } catch (err) {
        total.errors.push(`Google connector ${conn.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (conn.connector_type === 'AD' || conn.connector_type === 'LDAP') {
      const part = await syncAdDirectoryGroups(conn.id, cfg);
      total.groupsSynced += part.groupsSynced;
      total.membersSynced += part.membersSynced;
      total.errors.push(...part.errors);
    }
    // AD_AGENT groups sync during agent sync jobs (POST .../groups), not here.
  }

  return total;
}
