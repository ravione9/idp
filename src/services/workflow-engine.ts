/**
 * Workflow Engine
 * ---------------
 * Executes workflow_definitions whose trigger_event matches a platform event.
 * Each workflow is a ordered list of steps stored in steps_json.
 *
 * Supported step types:
 *   NOTIFY            — sendNotification (IN_APP / EMAIL / SLACK / TEAMS)
 *   GRANT_BIRTHRIGHT  — assignBirthrightEntitlements for the subject employee
 *   REVOKE_BIRTHRIGHT — revokeBirthrightEntitlements for the subject employee
 *   WEBHOOK           — HTTP POST to a configured URL
 */

import https from 'node:https';
import http from 'node:http';
import { v4 as uuidv4 } from 'uuid';
import { query, execute, queryOne } from '../db/connection.js';
import { assignBirthrightEntitlements, revokeBirthrightEntitlements } from './birthright.js';
import { sendNotification } from './notification.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type WorkflowStepType =
  | 'NOTIFY'
  | 'GRANT_BIRTHRIGHT'
  | 'REVOKE_BIRTHRIGHT'
  | 'WEBHOOK';

export interface WorkflowStep {
  type: WorkflowStepType;
  name?: string;
  config?: Record<string, unknown>;
}

interface WorkflowDefinitionRow {
  id: string;
  name: string;
  trigger_event: string | null;
  steps_json: string | WorkflowStep[] | null;
  active: number;
}

interface EmployeeRow {
  emp_id: string;
  full_name: string;
  dept_id: string | null;
  employment_type: string | null;
}

export interface WorkflowContext {
  eventType: string;
  initiatedBy?: string | undefined;
  payload?: Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export function parseWorkflowSteps(raw: string | WorkflowStep[] | null): WorkflowStep[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as WorkflowStep[]) : [];
  } catch {
    return [];
  }
}

async function postWebhook(
  url: string,
  body: Record<string, unknown>,
  secret?: string,
): Promise<void> {
  const payload = JSON.stringify(body);
  const parsed = new URL(url);
  const lib = parsed.protocol === 'https:' ? https : http;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(payload)),
    'User-Agent': 'Lenskart-IdP-Workflow/1.0',
  };
  if (secret) {
    headers['X-IdP-Signature'] = secret;
  }

  await new Promise<void>((resolve, reject) => {
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers,
      },
      (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Webhook returned HTTP ${res.statusCode}`));
          return;
        }
        resolve();
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function executeStep(
  step: WorkflowStep,
  emp: EmployeeRow,
  ctx: WorkflowContext,
): Promise<void> {
  switch (step.type) {
    case 'GRANT_BIRTHRIGHT':
      await assignBirthrightEntitlements(
        emp.emp_id,
        emp.dept_id ?? '',
        emp.employment_type ?? '',
      );
      return;

    case 'REVOKE_BIRTHRIGHT':
      await revokeBirthrightEntitlements(emp.emp_id);
      return;

    case 'NOTIFY': {
      const cfg = step.config ?? {};
      const channel = (cfg['channel'] as string) ?? 'IN_APP';
      const subject = (cfg['subject'] as string) ?? `Workflow: ${ctx.eventType}`;
      const body = (cfg['body'] as string) ?? `Workflow step executed for ${emp.full_name} (${emp.emp_id}).`;
      const recipient = (cfg['recipientEmpId'] as string) ?? emp.emp_id;
      await sendNotification({
        recipientEmpId: recipient,
        channel: channel as 'EMAIL' | 'SLACK' | 'TEAMS' | 'IN_APP',
        subject,
        body,
        referenceType: 'WORKFLOW',
      });
      return;
    }

    case 'WEBHOOK': {
      const cfg = step.config ?? {};
      const url = cfg['url'] as string | undefined;
      if (!url) throw new Error('WEBHOOK step missing config.url');
      await postWebhook(
        url,
        {
          eventType: ctx.eventType,
          empId: emp.emp_id,
          fullName: emp.full_name,
          payload: ctx.payload ?? {},
          timestamp: new Date().toISOString(),
        },
        cfg['secret'] as string | undefined,
      );
      return;
    }

    default:
      throw new Error(`Unknown workflow step type: ${String((step as WorkflowStep).type)}`);
  }
}

// ---------------------------------------------------------------------------
// runWorkflow — execute a single workflow definition for one employee
// ---------------------------------------------------------------------------
export async function runWorkflow(
  workflow: WorkflowDefinitionRow,
  empId: string,
  ctx: WorkflowContext,
): Promise<string> {
  const steps = parseWorkflowSteps(workflow.steps_json);
  const runId = uuidv4();

  const emp = await queryOne<EmployeeRow>(
    `SELECT emp_id, full_name, dept_id, employment_type FROM employees WHERE emp_id = ?`,
    [empId],
  );
  if (!emp) {
    throw new Error(`Employee not found: ${empId}`);
  }

  await execute(
    `INSERT INTO workflow_runs
       (id, workflow_id, emp_id, trigger_event, current_step, steps_total, status, context_json)
     VALUES (?, ?, ?, ?, 0, ?, 'RUNNING', ?)`,
    [
      runId,
      workflow.id,
      empId,
      ctx.eventType,
      steps.length,
      JSON.stringify(ctx.payload ?? {}),
    ],
  );

  const log = logger.child({ runId, workflowId: workflow.id, empId, event: ctx.eventType });

  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      log.info({ stepIndex: i, stepType: step.type }, 'Executing workflow step');
      await executeStep(step, emp, ctx);
      await execute(
        `UPDATE workflow_runs SET current_step = ? WHERE id = ?`,
        [i + 1, runId],
      );
    }

    await execute(
      `UPDATE workflow_runs SET status = 'COMPLETED', ended_at = UTC_TIMESTAMP() WHERE id = ?`,
      [runId],
    );
    log.info('Workflow run completed');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await execute(
      `UPDATE workflow_runs SET status = 'FAILED', error_message = ?, ended_at = UTC_TIMESTAMP() WHERE id = ?`,
      [message.slice(0, 2000), runId],
    );
    log.error({ err }, 'Workflow run failed');
    throw err;
  }

  return runId;
}

// ---------------------------------------------------------------------------
// runWorkflowsForEvent — find and execute all matching active workflows
// ---------------------------------------------------------------------------
export async function runWorkflowsForEvent(
  eventType: string,
  empId: string,
  ctx?: Partial<WorkflowContext>,
): Promise<string[]> {
  const workflows = await query<WorkflowDefinitionRow>(
    `SELECT id, name, trigger_event, steps_json, active
       FROM workflow_definitions
      WHERE active = 1 AND trigger_event = ?
      ORDER BY name`,
    [eventType],
  );

  if (workflows.length === 0) return [];

  const fullCtx: WorkflowContext = {
    eventType,
    ...(ctx?.initiatedBy !== undefined ? { initiatedBy: ctx.initiatedBy } : {}),
    ...(ctx?.payload !== undefined ? { payload: ctx.payload } : {}),
  };

  const runIds: string[] = [];
  for (const wf of workflows) {
    try {
      const runId = await runWorkflow(wf, empId, fullCtx);
      runIds.push(runId);
    } catch (err) {
      logger.error({ workflowId: wf.id, empId, eventType, err }, 'Workflow execution failed');
    }
  }
  return runIds;
}
