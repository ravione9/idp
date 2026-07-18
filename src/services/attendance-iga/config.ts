import { queryOne, execute } from '../../db/connection.js';
import { parseJsonField } from './fetcher.js';
import type { AttendanceAction, AttendanceIgaConfig, AttendanceSource, SftpConfig } from './types.js';

export async function loadAttendanceIgaConfig(): Promise<AttendanceIgaConfig> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM attendance_iga_config WHERE id = 1`,
    [],
  );
  if (!row) throw new Error('Attendance IGA config not initialized');

  return {
    id: Number(row['id']),
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

export async function updateSyncStatus(
  status: 'OK' | 'FAILED' | 'PARTIAL',
  error?: string,
): Promise<void> {
  await execute(
    `UPDATE attendance_iga_config
        SET last_sync_at = UTC_TIMESTAMP(),
            last_sync_status = ?,
            last_sync_error = ?
      WHERE id = 1`,
    [status, error ?? null],
  );
}

export function resolveActions(
  ruleActions: AttendanceAction[] | null | undefined,
  config: AttendanceIgaConfig,
): AttendanceAction[] {
  if (ruleActions && ruleActions.length > 0) return ruleActions;
  return config.connector_actions ?? ['SUSPEND_USER', 'REVOKE_SESSIONS'];
}

export async function updateSftpLastFile(remoteFile: string): Promise<void> {
  await execute(
    `UPDATE attendance_iga_config SET sftp_last_file = ? WHERE id = 1`,
    [remoteFile.slice(0, 512)],
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
