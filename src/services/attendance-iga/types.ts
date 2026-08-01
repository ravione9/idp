export type AttendanceSource = 'REST_API' | 'FILE_UPLOAD' | 'SFTP' | 'MANUAL' | 'BOTH';
export type IdentifierField = 'EMPLOYEE_ID' | 'EMPLOYEE_CODE' | 'EMAIL' | 'USERNAME';
export type AttendanceAction =
  | 'SUSPEND_USER'
  | 'DISABLE_USER'
  | 'REVOKE_SESSIONS'
  | 'REMOVE_ALL_APPS'
  | 'REMOVE_GROUPS'
  | 'REMOVE_ROLES'
  | 'REMOVE_LICENSES';

export interface EmployeeScope {
  /** Empty = all departments. Match against employees.dept_id (case-insensitive). */
  departments: string[];
  /** Empty = all types. Match against employees.employment_type (CORPORATE/STORE/PLANT/DC). */
  employment_types: string[];
}

export interface AttendanceIgaConfig {
  id: number;
  name: string;
  slug: string;
  employee_scope: EmployeeScope;
  enabled: number;
  source_type: 'REST_API' | 'FILE_UPLOAD' | 'SFTP' | 'BOTH';
  api_provider: 'GENERIC' | 'TRUIN';
  api_url: string | null;
  api_method: 'GET' | 'POST';
  api_auth_type: 'NONE' | 'BEARER' | 'BASIC' | 'API_KEY';
  api_auth_config: Record<string, unknown> | null;
  api_headers: Record<string, string> | null;
  api_body_template: Record<string, unknown> | null;
  api_config: TrueinApiConfig | Record<string, unknown> | null;
  sftp_config: SftpConfig | null;
  sftp_last_file: string | null;
  polling_interval: '5m' | '15m' | '1h' | '1d' | 'manual';
  file_mapping_json: Record<string, string> | null;
  identifier_field: IdentifierField;
  cutoff_time: string;
  /**
   * DAILY_LIVE — evaluate today's missed punch after cutoff (plus consecutive rules).
   * CONSECUTIVE_ABSENT — skip same-day rule; only act when absent for `consecutive_days`
   * and fetch/consume that many days of punch data.
   */
  evaluation_mode: 'DAILY_LIVE' | 'CONSECUTIVE_ABSENT';
  consecutive_days: number;
  approval_enabled: number;
  emergency_mode: number;
  notify_channels: string[] | null;
  notify_recipients: string[] | null;
  connector_actions: AttendanceAction[] | null;
  last_sync_at: string | null;
  last_sync_status: 'OK' | 'FAILED' | 'PARTIAL' | null;
  last_sync_error: string | null;
}

export interface SftpConfig {
  host: string;
  port?: number | undefined;
  username: string;
  password?: string | undefined;
  privateKey?: string | undefined;
  passphrase?: string | undefined;
  /** Exact remote file path (supports date tokens, e.g. /incoming/attendance_{YYYY-MM-DD}.csv) */
  remotePath?: string | undefined;
  /** Directory combined with fileNameTemplate */
  remoteDir?: string | undefined;
  /** Daily file name template, e.g. attendance_{YYYYMMDD}.csv */
  fileNameTemplate?: string | undefined;
  /** Glob pattern when scanning remoteDir (supports date tokens) */
  filePattern?: string | undefined;
  /** IANA timezone for date tokens (default Asia/Kolkata) */
  timezone?: string | undefined;
  /** Day offset from today for file date (0 = today, -1 = yesterday) */
  dateOffsetDays?: number | undefined;
  /** If today's file missing, try previous N days */
  lookbackDays?: number | undefined;
  /** Move file here after successful fetch */
  archiveDir?: string | undefined;
  /** Delete remote file after successful fetch (ignored if archiveDir is set) */
  deleteAfterFetch?: boolean | undefined;
}

/** Truein / custom REST provider settings (stored in api_config JSON). */
export interface TrueinApiConfig {
  baseUrl?: string | undefined;
  endpoint?: string | undefined;
  siteId?: string | undefined;
  clientId?: string | undefined;
  dateParam?: string | undefined;
  fromDateParam?: string | undefined;
  toDateParam?: string | undefined;
  dateFormat?: 'YYYY-MM-DD' | 'DD-MM-YYYY' | 'YYYYMMDD' | undefined;
  timezone?: string | undefined;
  dateOffsetDays?: number | undefined;
  lookbackDays?: number | undefined;
  recordsPath?: string | undefined;
  method?: 'GET' | 'POST' | undefined;
}

export interface StagingRow {
  raw_identifier?: string | undefined;
  raw_email?: string | undefined;
  raw_username?: string | undefined;
  punch_date?: string | undefined;
  punch_time?: string | undefined;
  punch_ts?: string | undefined;
  source_row?: number | undefined;
  raw_json?: Record<string, unknown> | undefined;
}

export interface ImportReport {
  totalRecords: number;
  successful: number;
  failed: number;
  duplicates: number;
  unmatched: number;
  validationErrors: Array<{ row: number; errors: string[] }>;
}

export interface RuleEvaluation {
  empId: string;
  ruleKey: string;
  ruleName: string;
  attendanceStatus: string;
  /** Consecutive calendar days without punch that triggered the rule (1 for same-day). */
  absentDays: number | null;
  actionRecommended: string | null;
  skippedReason: string | null;
  actions: AttendanceAction[];
}

export interface RollbackSnapshot {
  empId: string;
  previousIlgState: string;
  appAssignments: Array<{ id: string; app_id: string; assignment_type: string; target_id: string; active: number }>;
  entitlements: Array<{ id: number; entitlement_id: string; source: string }>;
  groupMembers: Array<{ group_id: string; emp_id: string }>;
  userRoles: Array<{ id: number; role_id: string }>;
}

export interface PipelineResult {
  importRunId: string;
  status: 'COMPLETED' | 'FAILED' | 'PARTIAL';
  report: ImportReport;
  evaluations: number;
  approvalsCreated: number;
  executions: number;
  error?: string;
}
