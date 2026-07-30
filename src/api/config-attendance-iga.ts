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
import { query, execute } from '../db/connection.js';
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
  const limit = Math.min(parseInt((req.query['limit'] as string) ?? '50', 10), 200);
  const rows = await query(
    `SELECT x.*, e.full_name, e.dept_id
       FROM attendance_iga_executions x
       JOIN employees e ON e.emp_id = x.emp_id
      ORDER BY x.executed_at DESC LIMIT ?`,
    [limit],
  );
  res.json({ data: rows });
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
