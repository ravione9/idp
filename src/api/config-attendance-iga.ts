/**
 * Attendance-Based Identity Governance — admin API
 * Mounted at /api/admin/attendance-iga
 */
import { Router, Request } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../auth/middleware.js';
import { requireRole, requirePortalModule } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import { query, queryOne, execute } from '../db/connection.js';
import {
  loadAttendanceIgaConfig,
  listAttendanceIgaConfigs,
  createAttendanceIgaConfig,
  deleteAttendanceIgaConfig,
  updatePunchRuleActions,
  getPunchRuleActions,
} from '../services/attendance-iga/config.js';
import {
  getAttendanceIgaDashboard,
  processApprovalDecision,
  runAttendanceIgaPipeline,
} from '../services/attendance-iga/orchestrator.js';
import { rollbackExecution } from '../services/attendance-iga/actions.js';
import { previewSftpPaths } from '../services/attendance-iga/sftp-fetcher.js';
import { previewTrueinRequest, testTrueinConnection } from '../services/attendance-iga/truein-client.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('ADMIN', 'SUPER_ADMIN'), requirePortalModule('governance'));

function actor(req: Request): string {
  return (req as unknown as { user?: { empId?: string } }).user?.empId ?? 'SYSTEM';
}

function configIdFromReq(req: Request, fallback = 1): number {
  const q = req.query['configId'] ?? req.body?.configId ?? req.params['configId'];
  const n = Number(q ?? fallback);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const employeeScopeSchema = z.object({
  departments: z.array(z.string().max(100)).max(200).optional(),
  employment_types: z.array(z.enum(['CORPORATE', 'STORE', 'PLANT', 'DC'])).max(10).optional(),
}).optional();

const sftpConfigSchema = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().min(1).max(255),
  password: z.string().max(512).optional(),
  privateKey: z.string().max(8192).optional(),
  passphrase: z.string().max(512).optional(),
  remotePath: z.string().max(512).optional(),
  remoteDir: z.string().max(512).optional(),
  fileNameTemplate: z.string().max(256).optional(),
  filePattern: z.string().max(128).optional(),
  timezone: z.string().max(64).optional(),
  dateOffsetDays: z.number().int().min(-30).max(30).optional(),
  lookbackDays: z.number().int().min(0).max(14).optional(),
  archiveDir: z.string().max(512).optional(),
  deleteAfterFetch: z.boolean().optional(),
});

const trueinApiConfigSchema = z.object({
  baseUrl: z.string().max(512).optional(),
  endpoint: z.string().max(256).optional(),
  siteId: z.string().max(128).optional(),
  clientId: z.string().max(128).optional(),
  dateParam: z.string().max(64).optional(),
  fromDateParam: z.string().max(64).optional(),
  toDateParam: z.string().max(64).optional(),
  dateFormat: z.enum(['YYYY-MM-DD', 'DD-MM-YYYY', 'YYYYMMDD']).optional(),
  timezone: z.string().max(64).optional(),
  dateOffsetDays: z.number().int().min(-30).max(30).optional(),
  lookbackDays: z.number().int().min(0).max(14).optional(),
  recordsPath: z.string().max(128).optional(),
  method: z.enum(['GET', 'POST']).optional(),
});

const attendanceActionSchema = z.enum([
  'SUSPEND_USER',
  'DISABLE_USER',
  'REVOKE_SESSIONS',
  'REMOVE_ALL_APPS',
  'REMOVE_GROUPS',
  'REMOVE_ROLES',
  'REMOVE_LICENSES',
]);

const punchRuleActionsSchema = z.object({
  no_punch_today: z.array(attendanceActionSchema).max(6),
  no_punch_consecutive: z.array(attendanceActionSchema).max(6),
}).optional();

const configSchema = z.object({
  enabled: z.number().int().min(0).max(1).optional(),
  source_type: z.enum(['REST_API', 'FILE_UPLOAD', 'SFTP', 'BOTH']).optional(),
  api_provider: z.enum(['GENERIC', 'TRUIN']).optional(),
  api_url: z.string().max(512).optional(),
  api_method: z.enum(['GET', 'POST']).optional(),
  api_auth_type: z.enum(['NONE', 'BEARER', 'BASIC', 'API_KEY']).optional(),
  api_auth_config: z.record(z.unknown()).optional(),
  api_headers: z.record(z.string()).optional(),
  api_body_template: z.record(z.unknown()).optional(),
  api_config: trueinApiConfigSchema.optional(),
  sftp_config: sftpConfigSchema.nullable().optional(),
  polling_interval: z.enum(['5m', '15m', '1h', '1d', 'manual']).optional(),
  file_mapping_json: z.record(z.string()).optional(),
  identifier_field: z.enum(['EMPLOYEE_ID', 'EMPLOYEE_CODE', 'EMAIL', 'USERNAME']).optional(),
  cutoff_time: z.string().optional(),
  evaluation_mode: z.enum(['DAILY_LIVE', 'CONSECUTIVE_ABSENT']).optional(),
  consecutive_days: z.number().int().min(1).max(30).optional(),
  approval_enabled: z.number().int().min(0).max(1).optional(),
  emergency_mode: z.number().int().min(0).max(1).optional(),
  notify_channels: z.array(z.string()).optional(),
  notify_recipients: z.array(z.string()).optional(),
  connector_actions: z.array(z.string()).optional(),
  name: z.string().min(1).max(150).optional(),
  slug: z.string().min(1).max(80).optional(),
  employee_scope: employeeScopeSchema,
  punch_rule_actions: punchRuleActionsSchema,
});

router.get('/dashboard', asyncHandler(async (req, res) => {
  res.json(await getAttendanceIgaDashboard(configIdFromReq(req)));
}));

function redactAttendanceConfig(config: Awaited<ReturnType<typeof loadAttendanceIgaConfig>>) {
  const auth = { ...(config.api_auth_config ?? {}) };
  const hasToken = Boolean(auth['token'] || auth['password'] || auth['apiKey'] || auth['api_key']);
  if (auth['token']) auth['token'] = '';
  if (auth['password']) auth['password'] = '';
  if (auth['apiKey']) auth['apiKey'] = '';
  if (auth['api_key']) auth['api_key'] = '';

  let sftp = config.sftp_config;
  let hasSftpPassword = false;
  let hasSftpPrivateKey = false;
  if (sftp) {
    hasSftpPassword = Boolean(sftp.password);
    hasSftpPrivateKey = Boolean(sftp.privateKey);
    sftp = {
      ...sftp,
      password: hasSftpPassword ? '' : undefined,
      privateKey: hasSftpPrivateKey ? '' : undefined,
      passphrase: sftp.passphrase ? '' : undefined,
    };
  }

  return {
    ...config,
    api_auth_config: auth,
    sftp_config: sftp,
    has_api_token: hasToken,
    has_sftp_password: hasSftpPassword,
    has_sftp_private_key: hasSftpPrivateKey,
  };
}

router.get('/configs', asyncHandler(async (_req, res) => {
  const configs = await listAttendanceIgaConfigs();
  res.json({ data: configs.map((c) => redactAttendanceConfig(c)) });
}));

router.post('/configs', asyncHandler(async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  const scope = req.body?.employee_scope as { departments?: string[]; employment_types?: string[] } | undefined;
  const created = await createAttendanceIgaConfig({
    name,
    slug: typeof req.body?.slug === 'string' ? req.body.slug : undefined,
    cloneFromId: req.body?.cloneFromId != null ? Number(req.body.cloneFromId) : 1,
    // Omit scope on clone so rules/settings inherit; empty arrays mean "all employees".
    ...(scope
      ? {
          employee_scope: {
            departments: scope.departments ?? [],
            employment_types: scope.employment_types ?? [],
          },
        }
      : {}),
    createdBy: actor(req),
  });
  res.status(201).json(created);
}));

router.delete('/configs/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params['id']);
  try {
    await deleteAttendanceIgaConfig(id);
    res.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(msg.includes('Cannot delete') || msg.includes('not found') ? 409 : 500).json({ error: msg });
  }
}));

router.get('/config', asyncHandler(async (req, res) => {
  const configId = configIdFromReq(req);
  const config = await loadAttendanceIgaConfig(configId);
  const punch_rule_actions = await getPunchRuleActions(configId);
  res.json({ ...redactAttendanceConfig(config), punch_rule_actions });
}));

router.get('/sftp/preview', asyncHandler(async (req, res) => {
  const config = await loadAttendanceIgaConfig(configIdFromReq(req));
  res.json(previewSftpPaths(config.sftp_config));
}));

router.get('/api/preview', asyncHandler(async (req, res) => {
  const config = await loadAttendanceIgaConfig(configIdFromReq(req));
  const offset = parseInt((req.query['offset'] as string) ?? '0', 10);
  if (config.api_provider === 'TRUIN') {
    res.json(previewTrueinRequest(config, offset));
    return;
  }
  const apiCfg = (config.api_config ?? {}) as Record<string, unknown>;
  const tz = typeof apiCfg['timezone'] === 'string' ? apiCfg['timezone'] : 'Asia/Kolkata';
  const url = config.api_url ?? '';
  res.json({
    url,
    method: config.api_method,
    note: 'Configure date tokens {YYYY-MM-DD} in URL for generic REST',
    timezone: tz,
  });
}));

router.post('/api/test', asyncHandler(async (req, res) => {
  const saved = await loadAttendanceIgaConfig(configIdFromReq(req));
  const draft = (req.body ?? {}) as Record<string, unknown>;
  // Merge form draft over saved config so Test works before Save.
  const config = {
    ...saved,
    api_provider: (draft['api_provider'] as typeof saved.api_provider) ?? saved.api_provider,
    api_url: typeof draft['api_url'] === 'string' ? draft['api_url'] : saved.api_url,
    api_method: (draft['api_method'] as typeof saved.api_method) ?? saved.api_method,
    api_auth_type: (draft['api_auth_type'] as typeof saved.api_auth_type) ?? saved.api_auth_type,
    api_auth_config: {
      ...(saved.api_auth_config ?? {}),
      ...((draft['api_auth_config'] as Record<string, unknown> | undefined) ?? {}),
    },
    api_config: {
      ...((saved.api_config as Record<string, unknown> | null) ?? {}),
      ...((draft['api_config'] as Record<string, unknown> | undefined) ?? {}),
    },
  };

  const provider = (draft['api_provider'] as string)
    || saved.api_provider
    || 'TRUIN';
  if (provider === 'TRUIN') {
    res.json(await testTrueinConnection({ ...config, api_provider: 'TRUIN' }));
    return;
  }
  if (!config.api_url) {
    res.status(400).json({ ok: false, message: 'API URL is not configured' });
    return;
  }
  try {
    const { assertSafeOutboundUrl } = await import('../utils/safe-url.js');
    await assertSafeOutboundUrl(config.api_url);
  } catch (err) {
    res.status(400).json({
      ok: false,
      message: err instanceof Error ? err.message : 'API URL is not allowed',
    });
    return;
  }
  const { fetchAttendanceFromApi } = await import('../services/attendance-iga/fetcher.js');
  const apiCfg = (config.api_config ?? {}) as Record<string, unknown>;
  const rows = await fetchAttendanceFromApi({
    apiUrl: config.api_url,
    apiMethod: config.api_method,
    apiAuthType: config.api_auth_type,
    apiAuthConfig: config.api_auth_config,
    apiHeaders: config.api_headers,
    apiBodyTemplate: config.api_body_template,
    fileMapping: config.file_mapping_json,
    recordsPath: typeof apiCfg['recordsPath'] === 'string' ? apiCfg['recordsPath'] : null,
    dateOffsetDays: typeof apiCfg['dateOffsetDays'] === 'number' ? apiCfg['dateOffsetDays'] : 0,
    timeZone: typeof apiCfg['timezone'] === 'string' ? apiCfg['timezone'] : 'Asia/Kolkata',
  });
  res.json({
    ok: true,
    recordCount: rows.length,
    message: `Connected — ${rows.length} record(s) returned`,
  });
}));

router.put('/config', asyncHandler(async (req, res) => {
  const parsed = configSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }
  const d = parsed.data;
  const id = configIdFromReq(req);
  const current = await loadAttendanceIgaConfig(id);

  // Preserve Bearer token when UI omits it (blank password field).
  let authConfig = d.api_auth_config;
  if (authConfig) {
    const incomingToken = authConfig['token'];
    if (!incomingToken && current.api_auth_config?.['token']) {
      authConfig = { ...authConfig, token: current.api_auth_config['token'] };
    }
  }

  const sftpSql = d.sftp_config === null
    ? 'sftp_config = NULL'
    : 'sftp_config = COALESCE(?, sftp_config)';

  const scopeJson = d.employee_scope
    ? JSON.stringify({
      departments: d.employee_scope.departments ?? [],
      employment_types: d.employee_scope.employment_types ?? [],
    })
    : null;

  await execute(
    `UPDATE attendance_iga_config SET
       name = COALESCE(?, name),
       slug = COALESCE(?, slug),
       employee_scope = COALESCE(?, employee_scope),
       enabled = COALESCE(?, enabled),
       source_type = COALESCE(?, source_type),
       api_provider = COALESCE(?, api_provider),
       api_url = COALESCE(?, api_url),
       api_method = COALESCE(?, api_method),
       api_auth_type = COALESCE(?, api_auth_type),
       api_auth_config = COALESCE(?, api_auth_config),
       api_headers = COALESCE(?, api_headers),
       api_body_template = COALESCE(?, api_body_template),
       api_config = COALESCE(?, api_config),
       ${sftpSql},
       polling_interval = COALESCE(?, polling_interval),
       file_mapping_json = COALESCE(?, file_mapping_json),
       identifier_field = COALESCE(?, identifier_field),
       cutoff_time = COALESCE(?, cutoff_time),
       evaluation_mode = COALESCE(?, evaluation_mode),
       consecutive_days = COALESCE(?, consecutive_days),
       approval_enabled = COALESCE(?, approval_enabled),
       emergency_mode = COALESCE(?, emergency_mode),
       notify_channels = COALESCE(?, notify_channels),
       notify_recipients = COALESCE(?, notify_recipients),
       connector_actions = COALESCE(?, connector_actions),
       updated_by = ?
     WHERE id = ?`,
    [
      d.name ?? null,
      d.slug ?? null,
      scopeJson,
      d.enabled ?? null,
      d.source_type ?? null,
      d.api_provider ?? null,
      d.api_url ?? null,
      d.api_method ?? null,
      d.api_auth_type ?? null,
      authConfig ? JSON.stringify(authConfig) : null,
      d.api_headers ? JSON.stringify(d.api_headers) : null,
      d.api_body_template ? JSON.stringify(d.api_body_template) : null,
      d.api_config ? JSON.stringify(d.api_config) : null,
      ...(d.sftp_config === null ? [] : [d.sftp_config ? JSON.stringify(d.sftp_config) : null]),
      d.polling_interval ?? null,
      d.file_mapping_json ? JSON.stringify(d.file_mapping_json) : null,
      d.identifier_field ?? null,
      d.cutoff_time ?? null,
      d.evaluation_mode ?? null,
      d.consecutive_days ?? null,
      d.approval_enabled ?? null,
      d.emergency_mode ?? null,
      d.notify_channels ? JSON.stringify(d.notify_channels) : null,
      d.notify_recipients ? JSON.stringify(d.notify_recipients) : null,
      d.connector_actions ? JSON.stringify(d.connector_actions) : null,
      actor(req),
      id,
    ],
  );

  if (d.punch_rule_actions) {
    await updatePunchRuleActions(id, {
      no_punch_today: d.punch_rule_actions.no_punch_today,
      no_punch_consecutive: d.punch_rule_actions.no_punch_consecutive,
    });
  }

  res.json({ success: true });
}));

router.get('/rules', asyncHandler(async (req, res) => {
  const rows = await query(
    `SELECT * FROM attendance_iga_rules WHERE config_id = ? ORDER BY priority ASC`,
    [configIdFromReq(req)],
  );
  res.json({ data: rows });
}));

router.put('/rules/:id', asyncHandler(async (req, res) => {
  const { active, actions_json, priority } = req.body as {
    active?: number; actions_json?: unknown; priority?: number;
  };
  await execute(
    `UPDATE attendance_iga_rules SET
       active = COALESCE(?, active),
       actions_json = COALESCE(?, actions_json),
       priority = COALESCE(?, priority),
       updated_at = UTC_TIMESTAMP()
     WHERE id = ?`,
    [active ?? null, actions_json ? JSON.stringify(actions_json) : null, priority ?? null, req.params['id']],
  );
  res.json({ success: true });
}));

router.get('/exclusions', asyncHandler(async (req, res) => {
  const rows = await query(
    `SELECT * FROM attendance_iga_exclusions WHERE active = 1 AND config_id = ? ORDER BY exclusion_type, value`,
    [configIdFromReq(req)],
  );
  res.json({ data: rows });
}));

router.post('/exclusions', asyncHandler(async (req, res) => {
  const { exclusion_type, value, notes } = req.body as {
    exclusion_type: 'VIP_USER' | 'DEPARTMENT' | 'EMPLOYEE'; value: string; notes?: string;
  };
  if (!exclusion_type || !value) {
    res.status(400).json({ error: 'exclusion_type and value required' });
    return;
  }
  const id = uuidv4();
  const configId = configIdFromReq(req);
  await execute(
    `INSERT INTO attendance_iga_exclusions (id, config_id, exclusion_type, value, notes)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE active = 1, notes = VALUES(notes)`,
    [id, configId, exclusion_type, value, notes ?? null],
  );
  res.status(201).json({ id });
}));

router.delete('/exclusions/:id', asyncHandler(async (req, res) => {
  await execute(`UPDATE attendance_iga_exclusions SET active = 0 WHERE id = ?`, [req.params['id']]);
  res.json({ success: true });
}));

router.get('/imports', asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt((req.query['limit'] as string) ?? '20', 10), 100);
  const configId = configIdFromReq(req);
  const rows = await query(
    `SELECT * FROM attendance_iga_import_runs WHERE config_id = ? ORDER BY started_at DESC LIMIT ?`,
    [configId, limit],
  );
  res.json({ data: rows });
}));

router.get('/imports/:id/staging', asyncHandler(async (req, res) => {
  const rows = await query(
    `SELECT * FROM attendance_iga_staging WHERE import_run_id = ? ORDER BY source_row LIMIT 500`,
    [req.params['id']],
  );
  res.json({ data: rows });
}));

router.post('/run', asyncHandler(async (req, res) => {
  const source = (req.body?.source as 'REST_API' | 'FILE_UPLOAD' | 'SFTP' | 'BOTH' | 'MANUAL') ?? 'MANUAL';
  const csvText = req.body?.csvText as string | undefined;
  const emergencyMode = Boolean(req.body?.emergencyMode);
  const result = await runAttendanceIgaPipeline({
    source,
    initiatedBy: actor(req),
    configId: configIdFromReq(req),
    ...(csvText !== undefined ? { csvText } : {}),
    emergencyMode,
  });
  res.json(result);
}));

router.get('/approvals', asyncHandler(async (req, res) => {
  const status = (req.query['status'] as string) ?? 'PENDING';
  const rows = await query(
    `SELECT a.*, e.full_name, e.dept_id
       FROM attendance_iga_approvals a
       JOIN employees e ON e.emp_id = a.emp_id
      WHERE a.status = ?
      ORDER BY a.created_at DESC LIMIT 100`,
    [status],
  );
  res.json({ data: rows });
}));

router.post('/approvals/:id/decision', asyncHandler(async (req, res) => {
  const decision = req.body?.decision as 'APPROVE' | 'REJECT' | 'SKIP';
  if (!['APPROVE', 'REJECT', 'SKIP'].includes(decision)) {
    res.status(400).json({ error: 'decision must be APPROVE, REJECT, or SKIP' });
    return;
  }
  await processApprovalDecision({
    approvalId: req.params['id']!,
    decision,
    approverEmpId: actor(req),
    ...(req.body?.note !== undefined ? { note: req.body.note as string } : {}),
  });
  res.json({ success: true });
}));

router.get('/executions', asyncHandler(async (req, res) => {
  const wantExportEarly = String(req.query['export'] ?? '') === 'csv';
  const limit = Math.min(
    parseInt((req.query['limit'] as string) ?? (wantExportEarly ? '5000' : '100'), 10),
    wantExportEarly ? 10000 : 500,
  );
  const configId = configIdFromReq(req);
  const q = String(req.query['q'] ?? '').trim().slice(0, 120);
  const statusFilter = String(req.query['status'] ?? '').trim().toUpperCase();
  const ruleFilter = String(req.query['rule'] ?? '').trim().slice(0, 50);
  const rolledBackRaw = String(req.query['rolledBack'] ?? '').trim();
  const actionFilter = String(req.query['action'] ?? '').trim().toUpperCase(); // SUSPEND | DISABLE | FAILED
  const fromDate = String(req.query['from'] ?? '').trim().slice(0, 10);
  const toDate = String(req.query['to'] ?? '').trim().slice(0, 10);
  const wantExport = String(req.query['export'] ?? '') === 'csv';

  const where: string[] = ['r.config_id = ?'];
  const params: unknown[] = [configId];

  if (q) {
    where.push('(e.full_name LIKE ? OR e.emp_id LIKE ? OR e.email_corp LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (statusFilter && ['SUCCESS', 'FAILED', 'PARTIAL'].includes(statusFilter)) {
    where.push('x.status = ?');
    params.push(statusFilter);
  }
  if (ruleFilter) {
    where.push('x.rule_key = ?');
    params.push(ruleFilter);
  }
  if (rolledBackRaw === '1' || rolledBackRaw === '0') {
    where.push('x.rolled_back = ?');
    params.push(Number(rolledBackRaw));
  }
  if (actionFilter === 'FAILED') {
    where.push(`(x.status IN ('FAILED','PARTIAL') OR (x.error_message IS NOT NULL AND x.error_message <> ''))`);
  } else if (actionFilter === 'SUSPEND') {
    where.push(`(x.actions_taken LIKE '%SUSPEND_USER%')`);
  } else if (actionFilter === 'DISABLE') {
    where.push(`(x.actions_taken LIKE '%DISABLE_USER%')`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
    where.push('x.executed_at >= ?');
    params.push(`${fromDate} 00:00:00`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    where.push('x.executed_at < DATE_ADD(?, INTERVAL 1 DAY)');
    params.push(toDate);
  }

  params.push(limit);

  const [config, punchActions, exceptions, rows] = await Promise.all([
    loadAttendanceIgaConfig(configId),
    getPunchRuleActions(configId),
    query<{
      id: string;
      exclusion_type: string;
      value: string;
      notes: string | null;
      full_name: string | null;
      email_corp: string | null;
    }>(
      `SELECT x.id, x.exclusion_type, x.value, x.notes, e.full_name, e.email_corp
         FROM attendance_iga_exclusions x
         LEFT JOIN employees e ON e.emp_id = x.value
          AND x.exclusion_type IN ('VIP_USER', 'EMPLOYEE')
        WHERE x.active = 1 AND x.config_id = ?
        ORDER BY x.exclusion_type, x.value`,
      [configId],
    ),
    query<{
      id: string;
      emp_id: string;
      full_name: string;
      dept_id: string | null;
      rule_key: string;
      absent_days: number | null;
      attendance_status: string | null;
      eval_attendance_status: string | null;
      actions_taken: unknown;
      status: string;
      error_message: string | null;
      rolled_back: number;
      executed_at: Date;
      executed_by: string;
      policy_name: string;
      consecutive_days: number;
    }>(
      `SELECT x.id, x.emp_id, e.full_name, e.dept_id, x.rule_key,
              x.absent_days, x.attendance_status,
              ev.attendance_status AS eval_attendance_status,
              x.actions_taken, x.status, x.error_message, x.rolled_back, x.executed_at, x.executed_by,
              c.name AS policy_name, c.consecutive_days
         FROM attendance_iga_executions x
         JOIN employees e ON e.emp_id = x.emp_id
         JOIN attendance_iga_import_runs r ON r.id = x.import_run_id
         JOIN attendance_iga_config c ON c.id = r.config_id
         LEFT JOIN attendance_iga_evaluations ev
           ON ev.import_run_id = x.import_run_id
          AND ev.emp_id = x.emp_id
          AND ev.rule_key = x.rule_key
        WHERE ${where.join(' AND ')}
        ORDER BY x.executed_at DESC
        LIMIT ?`,
      params,
    ),
  ]);

  const data = rows.map((row) => {
    const status = row.attendance_status ?? row.eval_attendance_status;
    const match = status?.match(/no_punch_(\d+)/);
    let absentDays = row.absent_days;
    if (absentDays == null) {
      if (row.rule_key === 'NO_PUNCH_TODAY') absentDays = 1;
      else if (match) absentDays = Number(match[1]);
      else if (row.rule_key === 'NO_PUNCH_CONSECUTIVE') absentDays = row.consecutive_days;
    }
    const actions = Array.isArray(row.actions_taken)
      ? row.actions_taken.map(String)
      : (() => {
          try { return JSON.parse(String(row.actions_taken ?? '[]')) as string[]; }
          catch { return []; }
        })();
    const policyAction = actions.includes('DISABLE_USER')
      ? 'DISABLE'
      : actions.includes('SUSPEND_USER')
        ? 'SUSPEND'
        : actions[0] ?? null;
    const failed = row.status === 'FAILED' || row.status === 'PARTIAL' || Boolean(row.error_message);
    return {
      ...row,
      absent_days: absentDays,
      attendance_status: status,
      policy_action: policyAction,
      actions_list: actions,
      failed,
      failure_reason: row.error_message
        || (row.status === 'FAILED' ? 'Suspend/disable failed' : null)
        || (row.status === 'PARTIAL' ? 'Partial failure during action execution' : null),
    };
  });

  // Group by execution calendar date (UTC date part of executed_at).
  const byDate = new Map<string, typeof data>();
  for (const row of data) {
    const raw = row.executed_at instanceof Date
      ? row.executed_at.toISOString()
      : String(row.executed_at ?? '');
    const dateKey = raw.slice(0, 10) || 'unknown';
    const bucket = byDate.get(dateKey) ?? [];
    bucket.push(row);
    byDate.set(dateKey, bucket);
  }
  const groups = [...byDate.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, items]) => ({
      date,
      count: items.length,
      suspended: items.filter((i) => i.policy_action === 'SUSPEND').length,
      disabled: items.filter((i) => i.policy_action === 'DISABLE').length,
      failed: items.filter((i) => i.failed).length,
      rolled_back: items.filter((i) => Number(i.rolled_back) === 1).length,
      items,
    }));

  if (wantExport) {
    const header = [
      'date', 'executed_at', 'emp_id', 'full_name', 'dept_id', 'rule_key',
      'absent_days', 'policy_action', 'status', 'failure_reason', 'rolled_back', 'executed_by',
    ];
    const lines = [header.join(',')];
    const escCsv = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    for (const g of groups) {
      for (const row of g.items) {
        const at = row.executed_at instanceof Date
          ? row.executed_at.toISOString()
          : String(row.executed_at ?? '');
        lines.push([
          g.date,
          at,
          row.emp_id,
          row.full_name,
          row.dept_id,
          row.rule_key,
          row.absent_days,
          row.policy_action,
          row.status,
          row.failure_reason,
          row.rolled_back ? 1 : 0,
          row.executed_by,
        ].map(escCsv).join(','));
      }
    }
    const filename = `attendance-iga-executions-${configId}-${fromDate || 'all'}-${toDate || 'all'}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(lines.join('\n'));
    return;
  }

  res.json({
    data,
    groups,
    filters: {
      q: q || null,
      status: statusFilter || null,
      rule: ruleFilter || null,
      rolledBack: rolledBackRaw === '' ? null : rolledBackRaw,
      action: actionFilter || null,
      from: fromDate || null,
      to: toDate || null,
      limit,
    },
    policy: {
      id: config.id,
      name: config.name,
      enabled: config.enabled === 1,
      evaluation_mode: config.evaluation_mode,
      consecutive_days: config.consecutive_days,
      cutoff_time: config.cutoff_time,
      actions: punchActions,
    },
    exceptions,
  });
}));

router.post('/executions/bulk-rollback', asyncHandler(async (req, res) => {
  const idsRaw = req.body?.ids;
  if (!Array.isArray(idsRaw) || idsRaw.length === 0) {
    res.status(400).json({ error: 'ids array required' });
    return;
  }
  const ids = [...new Set(idsRaw.map((id) => String(id)).filter(Boolean))].slice(0, 100);
  const configId = configIdFromReq(req);
  const byActor = actor(req);
  const results: Array<{ id: string; ok: boolean; error?: string }> = [];

  for (const id of ids) {
    const owned = await queryOne<{ id: string; rolled_back: number }>(
      `SELECT x.id, x.rolled_back
         FROM attendance_iga_executions x
         JOIN attendance_iga_import_runs r ON r.id = x.import_run_id
        WHERE x.id = ? AND r.config_id = ?`,
      [id, configId],
    );
    if (!owned) {
      results.push({ id, ok: false, error: 'Not found for this policy' });
      continue;
    }
    if (owned.rolled_back) {
      results.push({ id, ok: false, error: 'Already rolled back' });
      continue;
    }
    try {
      await rollbackExecution(id, byActor);
      results.push({ id, ok: true });
    } catch (err) {
      results.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  res.json({
    success: results.every((r) => r.ok),
    rolledBack: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  });
}));

router.post('/executions/:id/rollback', asyncHandler(async (req, res) => {
  await rollbackExecution(req.params['id']!, actor(req));
  res.json({ success: true });
}));

router.get('/rollbacks', asyncHandler(async (_req, res) => {
  const rows = await query(
    `SELECT r.*, x.emp_id, x.rule_key, e.full_name
       FROM attendance_iga_rollback_log r
       JOIN attendance_iga_executions x ON x.id = r.execution_id
       JOIN employees e ON e.emp_id = x.emp_id
      ORDER BY r.rolled_back_at DESC LIMIT 50`,
    [],
  );
  res.json({ data: rows });
}));

export default router;
