import { v4 as uuidv4 } from 'uuid';
import { query, queryOne, execute } from '../../db/connection.js';
import logger from '../../utils/logger.js';
import { fetchAttendanceFromApi, parseCsvToStaging } from './fetcher.js';
import { fetchAttendanceFromTruein } from './truein-client.js';
import { fetchAttendanceFromSftp } from './sftp-fetcher.js';
import { nowInTimezone } from './date-template.js';
import { loadAttendanceIgaConfig, updateSyncStatus, resolveActions, updateSftpLastFile } from './config.js';
import {
  executeAttendanceActions,
  notifyAttendanceAction,
} from './actions.js';
import { sendNotification } from '../notification.js';
import type {
  AttendanceAction,
  AttendanceIgaConfig,
  AttendanceSource,
  IdentifierField,
  ImportReport,
  PipelineResult,
  RuleEvaluation,
  StagingRow,
} from './types.js';

interface RuleRow {
  id: string;
  rule_key: string;
  name: string;
  rule_type: 'ACTION' | 'IGNORE';
  condition_json: string | Record<string, unknown> | null;
  actions_json: string | AttendanceAction[] | null;
  priority: number;
}

interface EmployeeCtx {
  emp_id: string;
  full_name: string;
  email_corp: string;
  dept_id: string | null;
  ilg_state: string;
  hrms_status: string;
  employment_type: string;
  state: string | null;
}

export async function runAttendanceIgaPipeline(params: {
  source: AttendanceSource;
  initiatedBy: string;
  csvText?: string | undefined;
  emergencyMode?: boolean | undefined;
}): Promise<PipelineResult> {
  const config = await loadAttendanceIgaConfig();
  const importRunId = uuidv4();
  const report: ImportReport = {
    totalRecords: 0,
    successful: 0,
    failed: 0,
    duplicates: 0,
    unmatched: 0,
    validationErrors: [],
  };

  await execute(
    `INSERT INTO attendance_iga_import_runs (id, source, status, initiated_by)
     VALUES (?, ?, 'RUNNING', ?)`,
    [importRunId, params.source, params.initiatedBy],
  );

  try {
    let stagingRows: StagingRow[] = [];

    if (params.source === 'REST_API' || params.source === 'BOTH') {
      if (config.api_provider === 'TRUIN') {
        stagingRows.push(...await fetchAttendanceFromTruein(config));
      } else {
        if (!config.api_url) throw new Error('Attendance API URL is not configured');
        const apiCfg = (config.api_config ?? {}) as Record<string, unknown>;
        stagingRows.push(...await fetchAttendanceFromApi({
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
        }));
      }
    }

    if (params.source === 'SFTP' || params.source === 'BOTH') {
      if (!config.sftp_config) {
        throw new Error('SFTP is not configured');
      }
      const sftpResult = await fetchAttendanceFromSftp({
        sftpConfig: config.sftp_config,
        fileMapping: config.file_mapping_json,
      });
      await updateSftpLastFile(sftpResult.remoteFile);
      stagingRows.push(...sftpResult.rows);
    }

    if (params.source === 'FILE_UPLOAD') {
      if (!params.csvText?.trim()) throw new Error('CSV content required for file upload');
      stagingRows = parseCsvToStaging(params.csvText, config.file_mapping_json);
    }

    report.totalRecords = stagingRows.length;
    if (stagingRows.length > 0) {
      await importToStaging(importRunId, stagingRows, config, report);
      await promoteMatchedAttendance(importRunId, config);
    }

    const importSources: AttendanceSource[] = ['REST_API', 'SFTP', 'BOTH', 'FILE_UPLOAD'];
    if (importSources.includes(params.source) && report.successful === 0) {
      const msg = 'No valid attendance records imported — rule evaluation skipped to protect users';
      logger.warn({ importRunId, source: params.source }, msg);
      await finalizeRun(importRunId, 'PARTIAL', report, {
        usersProcessed: 0,
        usersSuspended: 0,
        usersDisabled: 0,
        appsRemoved: 0,
      });
      await updateSyncStatus('PARTIAL', msg);
      return {
        importRunId,
        status: 'PARTIAL',
        report,
        evaluations: 0,
        approvalsCreated: 0,
        executions: 0,
        error: msg,
      };
    }

    await runActivityAggregate();

    const rules = await loadActiveRules();
    const evaluations = await evaluateAllEmployees(importRunId, config, rules, report);

    const emergency = params.emergencyMode ?? config.emergency_mode === 1;
    const approvalEnabled = config.approval_enabled === 1 && !emergency;

    let approvalsCreated = 0;
    let executions = 0;
    let suspended = 0;
    let disabled = 0;
    let appsRemoved = 0;

    for (const ev of evaluations) {
      if (!ev.actionRecommended || ev.actions.length === 0) continue;

      if (approvalEnabled) {
        const approvalId = await createApproval(importRunId, ev);
        approvalsCreated++;
        await notifyApprovers(importRunId, ev, approvalId);
        continue;
      }

      const result = await executeAttendanceActions({
        empId: ev.empId,
        actions: ev.actions,
        ruleKey: ev.ruleKey,
        importRunId,
        executedBy: params.initiatedBy,
      });
      executions++;
      if (ev.actions.includes('SUSPEND_USER')) suspended++;
      if (ev.actions.includes('DISABLE_USER')) disabled++;
      if (ev.actions.includes('REMOVE_ALL_APPS')) appsRemoved++;
      await notifyAttendanceAction({
        config,
        empId: ev.empId,
        ruleKey: ev.ruleKey,
        actions: ev.actions,
        executionId: result.executionId,
        reason: ev.attendanceStatus,
      });
    }

    const status: PipelineResult['status'] = report.failed > 0 ? 'PARTIAL' : 'COMPLETED';
    await finalizeRun(importRunId, status, report, {
      usersProcessed: evaluations.length,
      usersSuspended: suspended,
      usersDisabled: disabled,
      appsRemoved,
    });
    await updateSyncStatus(status === 'COMPLETED' ? 'OK' : 'PARTIAL');

    return {
      importRunId,
      status,
      report,
      evaluations: evaluations.length,
      approvalsCreated,
      executions,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ importRunId, err }, 'Attendance IGA pipeline failed');
    await execute(
      `UPDATE attendance_iga_import_runs
          SET status = 'FAILED', error_message = ?, completed_at = UTC_TIMESTAMP()
        WHERE id = ?`,
      [message.slice(0, 4000), importRunId],
    );
    await updateSyncStatus('FAILED', message);
    await notifyAdminsApiFailure(config, message);
    return {
      importRunId,
      status: 'FAILED',
      report,
      evaluations: 0,
      approvalsCreated: 0,
      executions: 0,
      error: message,
    };
  }
}

async function importToStaging(
  importRunId: string,
  rows: StagingRow[],
  _config: AttendanceIgaConfig,
  report: ImportReport,
): Promise<void> {
  const seen = new Set<string>();

  for (const row of rows) {
    const errors: string[] = [];
    if (!row.raw_identifier && !row.raw_email && !row.raw_username) {
      errors.push('Missing employee identifier');
    }
    if (!row.punch_ts && !row.punch_date) errors.push('Missing punch date/time');
    if (row.punch_date && Number.isNaN(Date.parse(row.punch_date))) errors.push('Invalid date');
    if (row.punch_time === '') errors.push('Empty punch time');

    const dedupeKey = `${row.raw_identifier}|${row.raw_email}|${row.punch_ts ?? row.punch_date}`;
    let status: 'VALID' | 'INVALID' | 'DUPLICATE' = 'VALID';
    if (errors.length > 0) {
      status = 'INVALID';
      report.failed++;
      report.validationErrors.push({ row: row.source_row ?? 0, errors });
    } else if (seen.has(dedupeKey)) {
      status = 'DUPLICATE';
      report.duplicates++;
    } else {
      seen.add(dedupeKey);
      report.successful++;
    }

    await execute(
      `INSERT INTO attendance_iga_staging
         (import_run_id, source_row, raw_identifier, raw_email, raw_username,
          punch_date, punch_time, punch_ts, status, validation_errors, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        importRunId,
        row.source_row ?? 0,
        row.raw_identifier ?? null,
        row.raw_email ?? null,
        row.raw_username ?? null,
        row.punch_date ?? null,
        row.punch_time ?? null,
        row.punch_ts ?? null,
        status,
        errors.length ? JSON.stringify(errors) : null,
        row.raw_json ? JSON.stringify(row.raw_json) : null,
      ],
    );
  }
}

async function matchEmployee(
  row: {
    raw_identifier: string | null;
    raw_email: string | null;
    raw_username: string | null;
  },
  field: IdentifierField,
): Promise<string | null> {
  if (field === 'EMPLOYEE_ID' && row.raw_identifier) {
    const hit = await queryOne<{ emp_id: string }>(`SELECT emp_id FROM employees WHERE emp_id = ?`, [row.raw_identifier]);
    if (hit) return hit.emp_id;
  }
  if ((field === 'EMPLOYEE_CODE' || field === 'EMPLOYEE_ID') && row.raw_identifier) {
    const hit = await queryOne<{ emp_id: string }>(`SELECT emp_id FROM employees WHERE emp_id = ?`, [row.raw_identifier]);
    if (hit) return hit.emp_id;
  }
  if (row.raw_email) {
    const hit = await queryOne<{ emp_id: string }>(
      `SELECT emp_id FROM employees WHERE LOWER(email_corp) = LOWER(?)`,
      [row.raw_email],
    );
    if (hit) return hit.emp_id;
  }
  if (row.raw_username || row.raw_identifier) {
    const username = row.raw_username ?? row.raw_identifier;
    const hit = await queryOne<{ emp_id: string }>(
      `SELECT emp_id FROM local_accounts WHERE LOWER(email) = LOWER(?) OR emp_id = ? LIMIT 1`,
      [username, username],
    );
    if (hit) return hit.emp_id;
  }
  if (row.raw_identifier) {
    const hit = await queryOne<{ emp_id: string }>(`SELECT emp_id FROM employees WHERE emp_id = ?`, [row.raw_identifier]);
    if (hit) return hit.emp_id;
  }
  return null;
}

async function promoteMatchedAttendance(importRunId: string, config: AttendanceIgaConfig): Promise<void> {
  const rows = await query<{
    id: number;
    raw_identifier: string | null;
    raw_email: string | null;
    raw_username: string | null;
    punch_ts: string | null;
    punch_date: string | null;
    punch_time: string | null;
  }>(
    `SELECT id, raw_identifier, raw_email, raw_username, punch_ts, punch_date, punch_time
       FROM attendance_iga_staging
      WHERE import_run_id = ? AND status = 'VALID'`,
    [importRunId],
  );

  for (const row of rows) {
    const empId = await matchEmployee(row, config.identifier_field);
    if (!empId) {
      await execute(`UPDATE attendance_iga_staging SET status = 'UNMATCHED' WHERE id = ?`, [row.id]);
      continue;
    }

    const punchTs = row.punch_ts
      ?? (row.punch_date ? `${row.punch_date} ${row.punch_time ?? '09:00:00'}` : null);
    if (punchTs) {
      await execute(
        `INSERT IGNORE INTO attendance_events (emp_id, event_ts, source, location)
         VALUES (?, ?, 'ATTENDANCE_IGA', 'import')`,
        [empId, punchTs],
      );
    }
    await execute(
      `UPDATE attendance_iga_staging SET status = 'MATCHED', matched_emp_id = ? WHERE id = ?`,
      [empId, row.id],
    );
  }
}

async function runActivityAggregate(): Promise<void> {
  await execute(
    `INSERT INTO activity_aggregate (emp_id, date, expected_to_work, has_attendance, has_leave, source)
     SELECT e.emp_id, d.date,
       CASE WHEN hc.date IS NOT NULL OR DAYOFWEEK(d.date) IN (1,7) THEN 0 ELSE 1 END,
       0, 0, 'ATTENDANCE_IGA'
     FROM employees e
     CROSS JOIN (SELECT CURDATE() AS date) d
     LEFT JOIN holiday_calendar hc ON hc.date = d.date
       AND (hc.state = e.state OR hc.format = 'ALL')
     WHERE e.ilg_state NOT IN ('DEPROVISIONED')
     ON DUPLICATE KEY UPDATE source = 'ATTENDANCE_IGA'`,
    [],
  );
  await execute(
    `UPDATE activity_aggregate aa
        JOIN (
          SELECT DATE(event_ts) AS date, emp_id FROM attendance_events GROUP BY emp_id, DATE(event_ts)
        ) ae ON ae.emp_id = aa.emp_id AND ae.date = aa.date
        SET aa.has_attendance = 1`,
    [],
  );
  await execute(
    `UPDATE activity_aggregate aa
        JOIN leave_records lr ON lr.emp_id = aa.emp_id
       AND aa.date BETWEEN lr.start_date AND lr.end_date AND lr.status = 'APPROVED'
        SET aa.has_leave = 1`,
    [],
  );
}

async function loadActiveRules(): Promise<RuleRow[]> {
  return query<RuleRow>(
    `SELECT id, rule_key, name, rule_type, condition_json, actions_json, priority
       FROM attendance_iga_rules WHERE active = 1 ORDER BY priority ASC`,
    [],
  );
}

async function loadExclusions(): Promise<{ type: string; value: string }[]> {
  return query<{ type: string; value: string }>(
    `SELECT exclusion_type AS type, value FROM attendance_iga_exclusions WHERE active = 1`,
    [],
  );
}

function parseActions(raw: RuleRow['actions_json'] | undefined): AttendanceAction[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as AttendanceAction[];
  try { return JSON.parse(String(raw)) as AttendanceAction[]; } catch { return []; }
}

async function evaluateAllEmployees(
  importRunId: string,
  config: AttendanceIgaConfig,
  rules: RuleRow[],
  report: ImportReport,
): Promise<RuleEvaluation[]> {
  const employees = await query<EmployeeCtx>(
    `SELECT emp_id, full_name, email_corp, dept_id, ilg_state, hrms_status, employment_type, state
       FROM employees WHERE ilg_state NOT IN ('DEPROVISIONED')`,
    [],
  );
  const exclusions = await loadExclusions();
  const results: RuleEvaluation[] = [];
  const tz = resolveConfigTimezone(config);
  const clock = nowInTimezone(tz);
  const today = clock.dateStr;
  const nowMinutes = clock.minutes;

  for (const emp of employees) {
    const skip = await evaluateIgnoreRules(emp, rules, exclusions, today, clock.dayOfWeek);
    if (skip) {
      await storeEvaluation(importRunId, emp.emp_id, skip.ruleKey, skip.ruleName, skip.attendanceStatus, null, skip.skippedReason, []);
      continue;
    }

    const actionEval = await evaluateActionRules(emp, rules, config, today, nowMinutes);
    if (actionEval) {
      const actions = resolveActions(actionEval.actions, config);
      await storeEvaluation(
        importRunId,
        emp.emp_id,
        actionEval.ruleKey,
        actionEval.ruleName,
        actionEval.attendanceStatus,
        actions.join(','),
        null,
        actions,
      );
      results.push({
        empId: emp.emp_id,
        ruleKey: actionEval.ruleKey,
        ruleName: actionEval.ruleName,
        attendanceStatus: actionEval.attendanceStatus,
        actionRecommended: actions.join(','),
        skippedReason: null,
        actions,
      });
    }
  }

  const unmatched = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM attendance_iga_staging WHERE import_run_id = ? AND status = 'UNMATCHED'`,
    [importRunId],
  );
  report.unmatched = unmatched?.n ?? 0;

  return results;
}

async function evaluateIgnoreRules(
  emp: EmployeeCtx,
  rules: RuleRow[],
  exclusions: { type: string; value: string }[],
  today: string,
  dayOfWeek: number,
): Promise<{ ruleKey: string; ruleName: string; attendanceStatus: string; skippedReason: string } | null> {
  for (const ex of exclusions) {
    if (ex.type === 'VIP_USER' && ex.value === emp.emp_id) {
      return { ruleKey: 'VIP_USER', ruleName: 'VIP User', attendanceStatus: 'excluded', skippedReason: 'VIP exclusion list' };
    }
    if (ex.type === 'DEPARTMENT' && ex.value === emp.dept_id) {
      return { ruleKey: 'EXCLUDED_DEPT', ruleName: 'Excluded Department', attendanceStatus: 'excluded', skippedReason: `Department ${emp.dept_id}` };
    }
    if (ex.type === 'EMPLOYEE' && ex.value === emp.emp_id) {
      return { ruleKey: 'EXCLUDED_DEPT', ruleName: 'Excluded Employee', attendanceStatus: 'excluded', skippedReason: 'Employee exclusion list' };
    }
  }

  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return { ruleKey: 'WEEKEND', ruleName: 'Weekend', attendanceStatus: 'weekend', skippedReason: 'Weekend' };
  }

  const holiday = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM holiday_calendar
      WHERE date = ? AND (state = ? OR format = 'ALL' OR format = ?)`,
    [today, emp.state ?? '', emp.employment_type],
  );
  if ((holiday?.n ?? 0) > 0) {
    return { ruleKey: 'HOLIDAY', ruleName: 'Holiday', attendanceStatus: 'holiday', skippedReason: 'Holiday calendar' };
  }

  const leave = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM leave_records
      WHERE emp_id = ? AND status = 'APPROVED' AND ? BETWEEN start_date AND end_date`,
    [emp.emp_id, today],
  );
  if ((leave?.n ?? 0) > 0) {
    return { ruleKey: 'APPROVED_LEAVE', ruleName: 'Approved Leave', attendanceStatus: 'on_leave', skippedReason: 'Approved leave' };
  }

  void rules;
  return null;
}

async function evaluateActionRules(
  emp: EmployeeCtx,
  rules: RuleRow[],
  config: AttendanceIgaConfig,
  today: string,
  nowMinutes: number,
): Promise<{ ruleKey: string; ruleName: string; attendanceStatus: string; actions: AttendanceAction[] } | null> {
  if (emp.hrms_status === 'DEPARTED' || emp.ilg_state === 'DEPARTED') {
    const rule = rules.find((r) => r.rule_key === 'TERMINATED');
    return {
      ruleKey: 'TERMINATED',
      ruleName: rule?.name ?? 'Employee Terminated',
      attendanceStatus: 'terminated',
      actions: parseActions(rule?.actions_json),
    };
  }

  const todayAgg = await queryOne<{ has_attendance: number; expected_to_work: number }>(
    `SELECT has_attendance, expected_to_work FROM activity_aggregate WHERE emp_id = ? AND date = ?`,
    [emp.emp_id, today],
  );

  if (todayAgg?.expected_to_work && !todayAgg.has_attendance && nowMinutes >= cutoffMinutes(config.cutoff_time)) {
    const rule = rules.find((r) => r.rule_key === 'NO_PUNCH_TODAY');
    return {
      ruleKey: 'NO_PUNCH_TODAY',
      ruleName: rule?.name ?? 'No Punch-In Today',
      attendanceStatus: 'no_punch_today',
      actions: parseActions(rule?.actions_json),
    };
  }

  const consecutive = await countConsecutiveNoPunchDays(emp.emp_id, config.consecutive_days);
  if (consecutive >= config.consecutive_days) {
    const rule = rules.find((r) => r.rule_key === 'NO_PUNCH_CONSECUTIVE');
    return {
      ruleKey: 'NO_PUNCH_CONSECUTIVE',
      ruleName: rule?.name ?? 'No Punch-In Consecutive Days',
      attendanceStatus: `no_punch_${consecutive}d`,
      actions: parseActions(rule?.actions_json),
    };
  }

  return null;
}

async function countConsecutiveNoPunchDays(empId: string, limit: number): Promise<number> {
  const days = await query<{ has_attendance: number; has_leave: number; expected_to_work: number }>(
    `SELECT has_attendance, has_leave, expected_to_work
       FROM activity_aggregate
      WHERE emp_id = ? AND expected_to_work = 1
      ORDER BY date DESC LIMIT ?`,
    [empId, limit + 2],
  );
  let count = 0;
  for (const d of days) {
    if (d.has_attendance || d.has_leave) break;
    count++;
  }
  return count;
}

async function storeEvaluation(
  importRunId: string,
  empId: string,
  ruleKey: string,
  ruleName: string,
  attendanceStatus: string,
  actionRecommended: string | null,
  skippedReason: string | null,
  _actions: AttendanceAction[],
): Promise<void> {
  await execute(
    `INSERT INTO attendance_iga_evaluations
       (id, import_run_id, emp_id, rule_key, rule_name, attendance_status, action_recommended, skipped_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidv4(), importRunId, empId, ruleKey, ruleName, attendanceStatus, actionRecommended, skippedReason],
  );
}

async function createApproval(importRunId: string, ev: RuleEvaluation): Promise<string> {
  const evalRow = await queryOne<{ id: string }>(
    `SELECT id FROM attendance_iga_evaluations
      WHERE import_run_id = ? AND emp_id = ? AND rule_key = ? ORDER BY evaluated_at DESC LIMIT 1`,
    [importRunId, ev.empId, ev.ruleKey],
  );
  const approvalId = uuidv4();
  await execute(
    `INSERT INTO attendance_iga_approvals
       (id, import_run_id, evaluation_id, emp_id, rule_key, actions_json, status)
     VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
    [approvalId, importRunId, evalRow?.id ?? uuidv4(), ev.empId, ev.ruleKey, JSON.stringify(ev.actions)],
  );
  return approvalId;
}

async function notifyApprovers(importRunId: string, ev: RuleEvaluation, approvalId: string): Promise<void> {
  const emp = await queryOne<{ manager_emp_id: string | null }>(
    `SELECT manager_emp_id FROM employees WHERE emp_id = ?`,
    [ev.empId],
  );
  const targets = new Set<string>();
  if (emp?.manager_emp_id) targets.add(emp.manager_emp_id);
  const admins = await query<{ emp_id: string }>(
    `SELECT la.emp_id FROM local_accounts la
      JOIN employees e ON e.emp_id = la.emp_id
     WHERE la.active = 1 AND e.ilg_state = 'ACTIVE' LIMIT 5`,
    [],
  );
  admins.forEach((a) => targets.add(a.emp_id));

  for (const recipientEmpId of targets) {
    await sendNotification({
      recipientEmpId,
      channel: 'IN_APP',
      subject: 'Attendance IGA approval required',
      body: `Approval needed for ${ev.empId} — rule ${ev.ruleKey}. Reference ${approvalId}. Import ${importRunId}.`,
      referenceId: approvalId,
      referenceType: 'ATTENDANCE_IGA_APPROVAL',
    }).catch(() => undefined);
  }
}

export async function processApprovalDecision(params: {
  approvalId: string;
  decision: 'APPROVE' | 'REJECT' | 'SKIP';
  approverEmpId: string;
  note?: string | undefined;
}): Promise<void> {
  const row = await queryOne<{
    id: string;
    import_run_id: string;
    emp_id: string;
    rule_key: string;
    actions_json: string;
    status: string;
  }>(
    `SELECT id, import_run_id, emp_id, rule_key, actions_json, status
       FROM attendance_iga_approvals WHERE id = ?`,
    [params.approvalId],
  );
  if (!row || row.status !== 'PENDING') throw new Error('Approval not pending');

  const statusMap = { APPROVE: 'APPROVED', REJECT: 'REJECTED', SKIP: 'SKIPPED' } as const;
  await execute(
    `UPDATE attendance_iga_approvals
        SET status = ?, approver_emp_id = ?, decision_note = ?, decided_at = UTC_TIMESTAMP()
      WHERE id = ?`,
    [statusMap[params.decision], params.approverEmpId, params.note ?? null, params.approvalId],
  );

  if (params.decision !== 'APPROVE') return;

  const actions = JSON.parse(row.actions_json) as AttendanceAction[];
  const config = await loadAttendanceIgaConfig();
  const result = await executeAttendanceActions({
    empId: row.emp_id,
    actions,
    ruleKey: row.rule_key,
    importRunId: row.import_run_id,
    executedBy: params.approverEmpId,
    approvalId: params.approvalId,
  });
  await notifyAttendanceAction({
    config,
    empId: row.emp_id,
    ruleKey: row.rule_key,
    actions,
    executionId: result.executionId,
    reason: 'Approved attendance action',
  });
}

async function finalizeRun(
  importRunId: string,
  status: 'COMPLETED' | 'PARTIAL' | 'FAILED',
  report: ImportReport,
  stats: { usersProcessed: number; usersSuspended: number; usersDisabled: number; appsRemoved: number },
): Promise<void> {
  await execute(
    `UPDATE attendance_iga_import_runs SET
       status = ?, total_records = ?, successful = ?, failed = ?, duplicates = ?, unmatched = ?,
       users_processed = ?, users_suspended = ?, users_disabled = ?, apps_removed = ?,
       report_json = ?, completed_at = UTC_TIMESTAMP()
     WHERE id = ?`,
    [
      status,
      report.totalRecords,
      report.successful,
      report.failed,
      report.duplicates,
      report.unmatched,
      stats.usersProcessed,
      stats.usersSuspended,
      stats.usersDisabled,
      stats.appsRemoved,
      JSON.stringify(report),
      importRunId,
    ],
  );
}

async function notifyAdminsApiFailure(config: AttendanceIgaConfig, message: string): Promise<void> {
  const recipients = config.notify_recipients ?? [];
  const admins = recipients.length
    ? recipients
    : (await query<{ emp_id: string }>(
      `SELECT la.emp_id FROM local_accounts la
        JOIN employees e ON e.emp_id = la.emp_id
       WHERE la.active = 1 AND e.ilg_state = 'ACTIVE' LIMIT 5`,
      [],
    )).map((a) => a.emp_id);

  for (const recipientEmpId of admins) {
    await sendNotification({
      recipientEmpId,
      channel: 'IN_APP',
      subject: 'Attendance API unavailable',
      body: `Attendance import failed after retries. No user suspensions were executed.\n\n${message}`,
      referenceType: 'ATTENDANCE_IGA_ERROR',
    }).catch(() => undefined);
  }
}

function cutoffMinutes(cutoff: string): number {
  const [h, m] = cutoff.split(':').map((v) => parseInt(v, 10));
  return (h ?? 10) * 60 + (m ?? 0);
}

function resolveConfigTimezone(config: AttendanceIgaConfig): string {
  const apiTz = (config.api_config as { timezone?: string } | null)?.timezone;
  const sftpTz = config.sftp_config?.timezone;
  return apiTz || sftpTz || 'Asia/Kolkata';
}

export async function getAttendanceIgaDashboard(): Promise<Record<string, unknown>> {
  const config = await loadAttendanceIgaConfig().catch(() => null);
  const todayImports = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM attendance_iga_import_runs
      WHERE DATE(started_at) = CURDATE()`,
    [],
  );
  const latestRun = await queryOne<Record<string, unknown>>(
    `SELECT * FROM attendance_iga_import_runs ORDER BY started_at DESC LIMIT 1`,
    [],
  );
  const pendingApprovals = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM attendance_iga_approvals WHERE status = 'PENDING'`,
    [],
  );
  const failedExecutions = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM attendance_iga_executions WHERE status = 'FAILED' AND DATE(executed_at) = CURDATE()`,
    [],
  );
  const rollbackCount = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM attendance_iga_rollback_log WHERE DATE(rolled_back_at) = CURDATE()`,
    [],
  );

  return {
    enabled: config?.enabled ?? 0,
    lastSyncAt: config?.last_sync_at ?? null,
    lastSyncStatus: config?.last_sync_status ?? null,
    connectorHealth: config?.last_sync_status === 'FAILED' ? 'ERROR' : 'OK',
    todayImports: todayImports?.n ?? 0,
    latestRun,
    pendingApprovals: pendingApprovals?.n ?? 0,
    failedExecutions: failedExecutions?.n ?? 0,
    rollbackCount: rollbackCount?.n ?? 0,
  };
}
