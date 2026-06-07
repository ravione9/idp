/**
 * Directory group sync — mirror Google Workspace / AD groups into `groups` + `group_members`.
 */

import { v4 as uuidv4 } from 'uuid';
import { google } from 'googleapis';
import type { admin_directory_v1 } from 'googleapis';
import { query, queryOne, execute } from '../db/connection.js';
import { ADAdapter } from '../adapters/ad-adapter.js';
import { redis } from '../auth/session-store.js';
import { config } from '../config.js';
import { parseConnectorBoolean, parseConnectorPort } from '../utils/connector-config.js';
import {
  buildGoogleJwtAuth,
  resolveGoogleSyncScope,
  parseCsvList,
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
  mail?: string;
  upn?: string;
  employeeId?: string;
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

export async function syncGoogleDirectoryGroups(
  connectorId: string,
  directory: admin_directory_v1.Admin,
  scope: GoogleSyncScope,
): Promise<GroupSyncSummary> {
  const summary: GroupSyncSummary = { groupsSynced: 0, membersSynced: 0, errors: [] };
  if (!scope.groups.length) return summary;

  const syncMembers = scope.syncGroupMemberships || scope.groups.length > 0;

  for (const groupEmail of scope.groups) {
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
          try {
            const u = await directory.users.get({ userKey: m.email });
            const empId = await resolveEmpIdByGoogleId(
              u.data.id ?? m.email,
              u.data.primaryEmail ?? m.email,
            );
            if (empId) empIds.push(empId);
          } catch {
            const empId = await resolveEmpIdByEmail(m.email);
            if (empId) empIds.push(empId);
          }
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

function createAdAdapterFromConfig(cfg: Record<string, unknown>): ADAdapter {
  const host = (cfg['host'] as string | undefined)?.trim() || new URL(config.ad.url).hostname;
  const useSsl = parseConnectorBoolean(cfg['useSsl'], config.ad.url.startsWith('ldaps'));
  const startTls = parseConnectorBoolean(cfg['startTls'], false);
  const port = parseConnectorPort(cfg['port'], useSsl ? 636 : 389);
  const bindDn = (cfg['bindDn'] as string | undefined) || config.ad.bindDn;
  const bindPass = (cfg['bindPassword'] as string | undefined) || config.ad.bindPassword;
  const baseDn = (cfg['baseDn'] as string | undefined) || config.ad.baseDn;
  const targetOuRaw = (cfg['targetOu'] as string | undefined)?.trim() ?? '';
  const adUrl = `${useSsl ? 'ldaps' : 'ldap'}://${host}:${port}`;
  return new ADAdapter(redis, adUrl, bindDn, bindPass, baseDn, undefined, startTls, targetOuRaw);
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

export async function syncAdDirectoryGroups(
  connectorId: string,
  cfg: Record<string, unknown>,
): Promise<GroupSyncSummary> {
  const summary: GroupSyncSummary = { groupsSynced: 0, membersSynced: 0, errors: [] };

  const adapter = createAdAdapterFromConfig(cfg);
  try {
    await adapter.connect();

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
  } finally {
    await adapter.disconnect().catch(() => undefined);
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
  }>(
    `SELECT id, connector_type, config_json FROM connectors WHERE status = 'ACTIVE'`,
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
      if (!scope.groups.length) continue;
      try {
        const auth = buildGoogleJwtAuth(cfg);
        const directory = google.admin({ version: 'directory_v1', auth });
        const part = await syncGoogleDirectoryGroups(conn.id, directory, scope);
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
  }

  return total;
}
