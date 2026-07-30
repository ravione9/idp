/**
 * Attendance IGA config load / multi-config CRUD / employee scope matching.
 */
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne, execute } from '../../db/connection.js';
import { parseJsonField } from './fetcher.js';
import type {
  AttendanceAction,
  AttendanceIgaConfig,
  AttendanceSource,
  EmployeeScope,
  SftpConfig,
} from './types.js';

function mapConfigRow(row: Record<string, unknown>): AttendanceIgaConfig {
  const scope = parseJsonField<EmployeeScope>(row['employee_scope']) ?? { departments: [], employment_types: [] };
  return {
    id: Number(row['id']),
    name: String(row['name'] ?? 'Default'),
    slug: String(row['slug'] ?? 'default'),
    employee_scope: {
      departments: Array.isArray(scope.departments) ? scope.departments.map(String) : [],
      employment_types: Array.isArray(scope.employment_types) ? scope.employment_types.map(String) : [],
    },
    enabled: Number(row['enabled'] ?? 0),
    source_type: (row['source_type'] as AttendanceIgaConfig['source_type']) ?? 'REST_API',
    api_provider: (row['api_provider'] as AttendanceIgaConfig['api_provider']) ?? 'GENERIC',
    api_url: (row['api_url'] as string | null) ?? null,
    api_method: (row['api_method'] as 'GET' | 'POST') ?? 'GET',
    api_auth_type: (row['api_auth_type'] as AttendanceIgaConfig['api_auth_type']) ?? 'NONE',
    api_auth_config: parseJsonField<Record<string, unknown>>(row['api_auth_config']),
    api_headers: parseJsonField<Record<string, string>>(row['api_headers']),
    api_body_template: parseJsonField<Record<string, unknown>>(row['api_body_template']),
    api_config: parseJsonField<Record<string, unknown>>(row['api_config']),
    sftp_config: parseJsonField<SftpConfig>(row['sftp_config']),
    sftp_last_file: (row['sftp_last_file'] as string | null) ?? null,
    polling_interval: (row['polling_interval'] as AttendanceIgaConfig['polling_interval']) ?? '1h',
    file_mapping_json: parseJsonField<Record<string, string>>(row['file_mapping_json']),
    identifier_field: (row['identifier_field'] as AttendanceIgaConfig['identifier_field']) ?? 'EMPLOYEE_ID',
    cutoff_time: String(row['cutoff_time'] ?? '10:00:00'),
    consecutive_days: Number(row['consecutive_days'] ?? 3),
    approval_enabled: Number(row['approval_enabled'] ?? 0),
    emergency_mode: Number(row['emergency_mode'] ?? 0),
    notify_channels: parseJsonField<string[]>(row['notify_channels']),
    notify_recipients: parseJsonField<string[]>(row['notify_recipients']),
    connector_actions: parseJsonField<AttendanceAction[]>(row['connector_actions']),
    last_sync_at: (row['last_sync_at'] as string | null) ?? null,
    last_sync_status: (row['last_sync_status'] as AttendanceIgaConfig['last_sync_status']) ?? null,
    last_sync_error: (row['last_sync_error'] as string | null) ?? null,
  };
}

export function slugifyConfigName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'config';
  return base;
}

/** Empty departments / employment_types = match all. */
export function employeeMatchesScope(
  emp: { dept_id?: string | null; employment_type?: string | null },
  scope: EmployeeScope | null | undefined,
): boolean {
  if (!scope) return true;
  const depts = (scope.departments ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean);
  const types = (scope.employment_types ?? []).map((t) => t.trim().toUpperCase()).filter(Boolean);
  if (depts.length > 0) {
    const dept = (emp.dept_id ?? '').trim().toLowerCase();
    if (!dept || !depts.includes(dept)) return false;
  }
  if (types.length > 0) {
    const et = (emp.employment_type ?? '').trim().toUpperCase();
    if (!et || !types.includes(et)) return false;
  }
  return true;
}

export async function listAttendanceIgaConfigs(): Promise<AttendanceIgaConfig[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM attendance_iga_config ORDER BY id ASC`,
    [],
  );
  return rows.map(mapConfigRow);
}

export async function loadAttendanceIgaConfig(configId = 1): Promise<AttendanceIgaConfig> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM attendance_iga_config WHERE id = ?`,
    [configId],
  );
  if (!row) throw new Error(`Attendance IGA config ${configId} not found`);
  return mapConfigRow(row);
}

export async function isAnyAttendanceIgaEnabled(): Promise<boolean> {
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM attendance_iga_config WHERE enabled = 1`,
    [],
  );
  return (row?.n ?? 0) > 0;
}

export async function createAttendanceIgaConfig(params: {
  name: string;
  slug?: string;
  cloneFromId?: number;
  employee_scope?: EmployeeScope;
  createdBy?: string;
}): Promise<{ id: number }> {
  const name = params.name.trim().slice(0, 150) || 'New config';
  let slug = (params.slug ?? slugifyConfigName(name)).slice(0, 80);
  const existing = await queryOne<{ id: number }>(
    `SELECT id FROM attendance_iga_config WHERE slug = ?`,
    [slug],
  );
  if (existing) slug = `${slug}-${Date.now().toString(36)}`.slice(0, 80);

  const cloneId = params.cloneFromId ?? 1;
  const source = await loadAttendanceIgaConfig(cloneId).catch(() => null);
  const scope = params.employee_scope ?? source?.employee_scope ?? { departments: [], employment_types: [] };

  const r = await execute(
    `INSERT INTO attendance_iga_config
       (name, slug, employee_scope, enabled, source_type, api_provider, api_url, api_method,
        api_auth_type, api_auth_config, api_headers, api_body_template, api_config,
        sftp_config, polling_interval, file_mapping_json, identifier_field, cutoff_time,
        consecutive_days, approval_enabled, emergency_mode, notify_channels, notify_recipients,
        connector_actions, updated_by)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name,
      slug,
      JSON.stringify(scope),
      source?.source_type ?? 'REST_API',
      source?.api_provider ?? 'TRUIN',
      source?.api_url ?? null,
      source?.api_method ?? 'GET',
      source?.api_auth_type ?? 'NONE',
      source?.api_auth_config ? JSON.stringify(source.api_auth_config) : null,
      source?.api_headers ? JSON.stringify(source.api_headers) : null,
      source?.api_body_template ? JSON.stringify(source.api_body_template) : null,
      source?.api_config ? JSON.stringify(source.api_config) : null,
      source?.sftp_config ? JSON.stringify(source.sftp_config) : null,
      source?.polling_interval ?? 'manual',
      source?.file_mapping_json ? JSON.stringify(source.file_mapping_json) : null,
      source?.identifier_field ?? 'EMPLOYEE_ID',
      source?.cutoff_time ?? '10:00:00',
      source?.consecutive_days ?? 3,
      source?.approval_enabled ?? 0,
      source?.emergency_mode ?? 0,
      source?.notify_channels ? JSON.stringify(source.notify_channels) : null,
      source?.notify_recipients ? JSON.stringify(source.notify_recipients) : null,
      source?.connector_actions ? JSON.stringify(source.connector_actions) : null,
      params.createdBy ?? null,
    ],
  );

  const newId = Number(r.insertId);
  if (!newId) throw new Error('Failed to create Attendance IGA config');

  // Clone rules from source config
  const rules = await query<Record<string, unknown>>(
    `SELECT rule_key, name, rule_type, condition_json, actions_json, priority, active
       FROM attendance_iga_rules WHERE config_id = ?`,
    [cloneId],
  );
  for (const rule of rules) {
    await execute(
      `INSERT INTO attendance_iga_rules
         (id, config_id, rule_key, name, rule_type, condition_json, actions_json, priority, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv4(),
        newId,
        rule['rule_key'],
        rule['name'],
        rule['rule_type'],
        typeof rule['condition_json'] === 'string'
          ? rule['condition_json']
          : JSON.stringify(rule['condition_json'] ?? null),
        typeof rule['actions_json'] === 'string'
          ? rule['actions_json']
          : JSON.stringify(rule['actions_json'] ?? null),
        rule['priority'] ?? 100,
        rule['active'] ?? 1,
      ],
    );
  }

  return { id: newId };
}

export async function deleteAttendanceIgaConfig(configId: number): Promise<void> {
  if (configId === 1) throw new Error('Cannot delete the Default config (id=1)');
  await execute(`DELETE FROM attendance_iga_rules WHERE config_id = ?`, [configId]);
  await execute(`DELETE FROM attendance_iga_exclusions WHERE config_id = ?`, [configId]);
  const r = await execute(`DELETE FROM attendance_iga_config WHERE id = ?`, [configId]);
  if (r.affectedRows === 0) throw new Error('Config not found');
}

/** Update ACTION rule payloads for missed-punch / consecutive-absence scenarios. */
export async function updatePunchRuleActions(
  configId: number,
  actions: {
    no_punch_today: AttendanceAction[];
    no_punch_consecutive: AttendanceAction[];
  },
): Promise<void> {
  await execute(
    `UPDATE attendance_iga_rules
        SET actions_json = ?, updated_at = UTC_TIMESTAMP()
      WHERE config_id = ? AND rule_key = 'NO_PUNCH_TODAY'`,
    [JSON.stringify(actions.no_punch_today), configId],
  );
  await execute(
    `UPDATE attendance_iga_rules
        SET actions_json = ?, updated_at = UTC_TIMESTAMP()
      WHERE config_id = ? AND rule_key = 'NO_PUNCH_CONSECUTIVE'`,
    [JSON.stringify(actions.no_punch_consecutive), configId],
  );
}

export async function getPunchRuleActions(configId: number): Promise<{
  no_punch_today: AttendanceAction[];
  no_punch_consecutive: AttendanceAction[];
}> {
  const rows = await query<{ rule_key: string; actions_json: unknown }>(
    `SELECT rule_key, actions_json FROM attendance_iga_rules
      WHERE config_id = ? AND rule_key IN ('NO_PUNCH_TODAY', 'NO_PUNCH_CONSECUTIVE')`,
    [configId],
  );
  const byKey = new Map(rows.map((r) => [r.rule_key, r.actions_json]));
  const parse = (raw: unknown, fallback: AttendanceAction[]): AttendanceAction[] => {
    if (Array.isArray(raw)) return raw.map(String) as AttendanceAction[];
    if (typeof raw === 'string') {
      try {
        const p = JSON.parse(raw) as unknown;
        if (Array.isArray(p)) return p.map(String) as AttendanceAction[];
      } catch { /* ignore */ }
    }
    return fallback;
  };
  return {
    no_punch_today: parse(byKey.get('NO_PUNCH_TODAY'), ['SUSPEND_USER']),
    no_punch_consecutive: parse(byKey.get('NO_PUNCH_CONSECUTIVE'), ['DISABLE_USER']),
  };
}

export async function updateSyncStatus(
  status: 'OK' | 'FAILED' | 'PARTIAL',
  error?: string,
  configId = 1,
): Promise<void> {
  await execute(
    `UPDATE attendance_iga_config
        SET last_sync_at = UTC_TIMESTAMP(),
            last_sync_status = ?,
            last_sync_error = ?
      WHERE id = ?`,
    [status, error ?? null, configId],
  );
}

export function resolveActions(
  ruleActions: AttendanceAction[] | null | undefined,
  config: AttendanceIgaConfig,
): AttendanceAction[] {
  if (ruleActions && ruleActions.length > 0) return ruleActions;
  return config.connector_actions ?? ['SUSPEND_USER', 'REVOKE_SESSIONS'];
}

export async function updateSftpLastFile(remoteFile: string, configId = 1): Promise<void> {
  await execute(
    `UPDATE attendance_iga_config SET sftp_last_file = ? WHERE id = ?`,
    [remoteFile.slice(0, 512), configId],
  );
}

export function scheduledPipelineSource(
  sourceType: AttendanceIgaConfig['source_type'],
): AttendanceSource | null {
  switch (sourceType) {
    case 'REST_API': return 'REST_API';
    case 'SFTP': return 'SFTP';
    case 'BOTH': return 'BOTH';
    default: return null;
  }
}

export function pollingIntervalMs(interval: AttendanceIgaConfig['polling_interval']): number | null {
  switch (interval) {
    case '5m': return 5 * 60_000;
    case '15m': return 15 * 60_000;
    case '1h': return 60 * 60_000;
    case '1d': return 24 * 60 * 60_000;
    default: return null;
  }
}

/** True when last_sync_at is null or older than the polling interval. */
export function configIsDue(config: AttendanceIgaConfig, now = Date.now()): boolean {
  const ms = pollingIntervalMs(config.polling_interval);
  if (!ms || config.enabled !== 1) return false;
  if (!config.last_sync_at) return true;
  const last = new Date(config.last_sync_at).getTime();
  if (!Number.isFinite(last)) return true;
  return now - last >= ms;
}
