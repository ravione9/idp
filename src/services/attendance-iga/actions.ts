import { v4 as uuidv4 } from 'uuid';
import { query, queryOne, execute } from '../../db/connection.js';
import { appendAuditLog } from '../../utils/audit-log.js';
import { enqueueOutboxOps, getIdentityLinksForEmp } from '../../utils/outbox.js';
import { redis } from '../../auth/session-store.js';
import { EmployeeStateMachine } from '../../fsm/employee-state-machine.js';
import { ILGState, TransitionActor, TransitionOrigin } from '../../fsm/states.js';
import { sendNotification } from '../notification.js';
import { revokeAllUserAppAccess } from '../app-access-policy.js';
import logger from '../../utils/logger.js';
import type { AttendanceAction, AttendanceIgaConfig, RollbackSnapshot } from './types.js';

const fsm = new EmployeeStateMachine();

export async function captureRollbackSnapshot(empId: string): Promise<RollbackSnapshot> {
  const emp = await queryOne<{ ilg_state: string }>(
    `SELECT ilg_state FROM employees WHERE emp_id = ?`,
    [empId],
  );
  const appAssignments = await query<RollbackSnapshot['appAssignments'][0]>(
    `SELECT id, app_id, assignment_type, target_id, active
       FROM app_access_assignments
      WHERE active = 1 AND assignment_type = 'USER' AND target_id = ?`,
    [empId],
  );
  const entitlements = await query<{ id: number; entitlement_id: string; source: string }>(
    `SELECT id, entitlement_id, source FROM user_entitlements
      WHERE emp_id = ? AND revoked_at IS NULL`,
    [empId],
  );
  const groupMembers = await query<{ group_id: string; emp_id: string }>(
    `SELECT group_id, emp_id FROM group_members WHERE emp_id = ?`,
    [empId],
  );
  const userRoles = await query<{ id: number; role_id: string }>(
    `SELECT id, role_id FROM user_roles WHERE emp_id = ?`,
    [empId],
  );

  return {
    empId,
    previousIlgState: emp?.ilg_state ?? ILGState.ACTIVE,
    appAssignments,
    entitlements,
    groupMembers,
    userRoles,
  };
}

export async function executeAttendanceActions(params: {
  empId: string;
  actions: AttendanceAction[];
  ruleKey: string;
  importRunId: string;
  executedBy: string;
  approvalId?: string;
  absentDays?: number | null;
  attendanceStatus?: string | null;
}): Promise<{ executionId: string; status: 'SUCCESS' | 'FAILED' | 'PARTIAL'; snapshot: RollbackSnapshot }> {
  const executionId = uuidv4();
  const snapshot = await captureRollbackSnapshot(params.empId);
  const appsRemoved: string[] = [];
  const groupsRemoved: string[] = [];
  const rolesRemoved: string[] = [];
  const actionsTaken: AttendanceAction[] = [];
  let connectorUsed = 'LILG';
  let errorMessage: string | null = null;
  let status: 'SUCCESS' | 'FAILED' | 'PARTIAL' = 'SUCCESS';

  try {
    for (const action of params.actions) {
      actionsTaken.push(action);
      switch (action) {
        case 'SUSPEND_USER':
          await fsm.transition({
            empId: params.empId,
            toState: ILGState.SUSPENDED_AUTO,
            actor: TransitionActor.SYSTEM,
            actorId: params.executedBy,
            origin: TransitionOrigin.LILG,
            reasonCode: `ATTENDANCE_IGA:${params.ruleKey}`,
            evidence: { importRunId: params.importRunId, ruleKey: params.ruleKey },
          });
          break;

        case 'DISABLE_USER':
          await fsm.transition({
            empId: params.empId,
            toState: ILGState.DEPROVISIONED,
            actor: TransitionActor.SYSTEM,
            actorId: params.executedBy,
            origin: TransitionOrigin.LILG,
            reasonCode: `ATTENDANCE_IGA:${params.ruleKey}`,
            evidence: { importRunId: params.importRunId, ruleKey: params.ruleKey },
          });
          break;

        case 'REVOKE_SESSIONS':
          await revokeSessions(params.empId);
          break;

        case 'REMOVE_ALL_APPS': {
          const r = await revokeAllUserAppAccess({
            empId: params.empId,
            revokedBy: params.executedBy,
            source: 'ATTENDANCE_IGA',
            reason: params.ruleKey,
          });
          appsRemoved.push(...r.appIds);
          break;
        }

        case 'REMOVE_GROUPS': {
          const members = await query<{ group_id: string }>(
            `SELECT group_id FROM group_members WHERE emp_id = ?`,
            [params.empId],
          );
          for (const m of members) {
            await execute(`DELETE FROM group_members WHERE emp_id = ? AND group_id = ?`, [params.empId, m.group_id]);
            groupsRemoved.push(m.group_id);
          }
          break;
        }

        case 'REMOVE_ROLES': {
          const roles = await query<{ id: number; role_id: string }>(
            `SELECT id, role_id FROM user_roles WHERE emp_id = ?`,
            [params.empId],
          );
          for (const r of roles) {
            await execute(`DELETE FROM user_roles WHERE id = ?`, [r.id]);
            rolesRemoved.push(r.role_id);
          }
          break;
        }

        case 'REMOVE_LICENSES':
          logger.info({ empId: params.empId }, 'REMOVE_LICENSES — no license store; logged only');
          break;
      }
    }

    const links = await getIdentityLinksForEmp(params.empId);
    if (links.length > 0) {
      connectorUsed = links.map((l) => l.system).join(',');
      await enqueueOutboxOps(
        params.empId,
        links.filter((l) => l.status === 'ACTIVE').map((l) => ({
          system: l.system,
          op: 'DISABLE' as const,
          payload: { externalId: l.external_id, reason: params.ruleKey },
          priority: 'HIGH' as const,
        })),
      );
    }
  } catch (err) {
    status = 'PARTIAL';
    errorMessage = err instanceof Error ? err.message : String(err);
    logger.error({ empId: params.empId, err }, 'Attendance IGA action execution failed');
  }

  await execute(
    `INSERT INTO attendance_iga_executions
       (id, import_run_id, approval_id, emp_id, rule_key, absent_days, attendance_status,
        actions_taken, connector_used, apps_removed, groups_removed, roles_removed,
        rollback_json, status, error_message, executed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      executionId,
      params.importRunId,
      params.approvalId ?? null,
      params.empId,
      params.ruleKey,
      params.absentDays ?? null,
      params.attendanceStatus ?? null,
      JSON.stringify(actionsTaken),
      connectorUsed,
      JSON.stringify(appsRemoved),
      JSON.stringify(groupsRemoved),
      JSON.stringify(rolesRemoved),
      JSON.stringify(snapshot),
      status,
      errorMessage,
      params.executedBy,
    ],
  );

  await appendAuditLog(
    params.executedBy,
    `ATTENDANCE_IGA_EXECUTE:${params.ruleKey}`,
    `employee:${params.empId}`,
    {
      executionId,
      importRunId: params.importRunId,
      actions: actionsTaken,
      appsRemoved,
      groupsRemoved,
      rolesRemoved,
      status,
    },
  );

  return { executionId, status, snapshot };
}

async function revokeSessions(empId: string): Promise<void> {
  const sessions = await query<{ session_id: string }>(
    `SELECT session_id FROM idp_sessions WHERE emp_id = ? AND revoked_at IS NULL`,
    [empId],
  );
  if (sessions.length === 0) return;
  await execute(
    `UPDATE idp_sessions SET revoked_at = UTC_TIMESTAMP() WHERE emp_id = ? AND revoked_at IS NULL`,
    [empId],
  );
  for (const s of sessions) {
    await redis.del(`idp:session:${s.session_id}`).catch(() => undefined);
  }
}

export async function rollbackExecution(
  executionId: string,
  rolledBackBy: string,
): Promise<void> {
  const exec = await queryOne<{
    id: string;
    emp_id: string;
    rollback_json: string | RollbackSnapshot;
    rolled_back: number;
  }>(
    `SELECT id, emp_id, rollback_json, rolled_back FROM attendance_iga_executions WHERE id = ?`,
    [executionId],
  );
  if (!exec) throw new Error('Execution not found');
  if (exec.rolled_back) throw new Error('Execution already rolled back');

  const snapshot = typeof exec.rollback_json === 'string'
    ? JSON.parse(exec.rollback_json) as RollbackSnapshot
    : exec.rollback_json;

  const current = await queryOne<{ ilg_state: string }>(
    `SELECT ilg_state FROM employees WHERE emp_id = ?`,
    [exec.emp_id],
  );
  if (current && current.ilg_state !== snapshot.previousIlgState) {
    await fsm.transition({
      empId: exec.emp_id,
      toState: snapshot.previousIlgState as ILGState,
      actor: TransitionActor.ADMIN,
      actorId: rolledBackBy,
      origin: TransitionOrigin.LILG,
      reasonCode: 'ATTENDANCE_IGA_ROLLBACK',
      evidence: { executionId },
    }).catch((err) => logger.warn({ err, executionId }, 'Rollback FSM transition failed'));
  }

  for (const a of snapshot.appAssignments) {
    if (a.active) {
      await execute(
        `UPDATE app_access_assignments SET active = 1, revoked_at = NULL, revoked_by = NULL WHERE id = ?`,
        [a.id],
      );
    }
  }
  for (const e of snapshot.entitlements) {
    await execute(
      `UPDATE user_entitlements SET revoked_at = NULL, revoked_by = NULL WHERE id = ?`,
      [e.id],
    );
  }
  for (const g of snapshot.groupMembers) {
    await execute(
      `INSERT IGNORE INTO group_members (group_id, emp_id, added_by) VALUES (?, ?, ?)`,
      [g.group_id, g.emp_id, rolledBackBy],
    );
  }
  for (const r of snapshot.userRoles) {
    await execute(
      `INSERT IGNORE INTO user_roles (emp_id, role_id, granted_by) VALUES (?, ?, ?)`,
      [exec.emp_id, r.role_id, rolledBackBy],
    );
  }

  const links = await getIdentityLinksForEmp(exec.emp_id);
  if (links.length > 0) {
    await enqueueOutboxOps(
      exec.emp_id,
      links.map((l) => ({
        system: l.system,
        op: 'ENABLE' as const,
        payload: { externalId: l.external_id, reason: 'ATTENDANCE_IGA_ROLLBACK' },
        priority: 'HIGH' as const,
      })),
    );
  }

  await execute(`UPDATE attendance_iga_executions SET rolled_back = 1 WHERE id = ?`, [executionId]);
  await execute(
    `INSERT INTO attendance_iga_rollback_log (id, execution_id, rolled_back_by, rollback_details)
     VALUES (?, ?, ?, ?)`,
    [uuidv4(), executionId, rolledBackBy, JSON.stringify({ snapshot, restoredBy: rolledBackBy })],
  );

  await appendAuditLog(
    rolledBackBy,
    'ATTENDANCE_IGA_ROLLBACK',
    `employee:${exec.emp_id}`,
    { executionId },
  );
}

export async function notifyAttendanceAction(params: {
  config: AttendanceIgaConfig;
  empId: string;
  ruleKey: string;
  actions: AttendanceAction[];
  executionId: string;
  reason: string;
}): Promise<void> {
  const emp = await queryOne<{ full_name: string; dept_id: string | null; email_corp: string }>(
    `SELECT full_name, dept_id, email_corp FROM employees WHERE emp_id = ?`,
    [params.empId],
  );
  if (!emp) return;

  const channels = params.config.notify_channels ?? ['IN_APP'];
  const recipients = params.config.notify_recipients ?? [];
  const body = [
    `Employee: ${emp.full_name} (${params.empId})`,
    `Department: ${emp.dept_id ?? '—'}`,
    `Reason: ${params.reason}`,
    `Rule: ${params.ruleKey}`,
    `Actions: ${params.actions.join(', ')}`,
    `Reference: ${params.executionId}`,
    `Time: ${new Date().toISOString()}`,
  ].join('\n');

  const notifyTargets = recipients.length > 0 ? recipients : [params.empId];
  for (const recipientEmpId of notifyTargets) {
    for (const channel of channels) {
      if (!['EMAIL', 'SLACK', 'TEAMS', 'IN_APP'].includes(channel)) continue;
      await sendNotification({
        recipientEmpId,
        channel: channel as 'EMAIL' | 'SLACK' | 'TEAMS' | 'IN_APP',
        subject: `Attendance IGA action — ${emp.full_name}`,
        body,
        referenceId: params.executionId,
        referenceType: 'ATTENDANCE_IGA',
      }).catch((err) => logger.warn({ err, recipientEmpId }, 'Attendance IGA notification failed'));
    }
  }
}
