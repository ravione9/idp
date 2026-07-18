/**
 * Event Dispatcher
 * ----------------
 * Central entry point for platform events. On each event:
 *   1. Fires matching event_triggers (webhook / Slack / email / workflow link)
 *   2. Starts matching workflow_definitions via workflow-engine
 *
 * Called fire-and-forget from lifecycle, FSM, and access-request paths.
 */

import https from 'node:https';
import http from 'node:http';
import { query, execute } from '../db/connection.js';
import { runWorkflowsForEvent } from './workflow-engine.js';
import { sendNotification } from './notification.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface EventTriggerRow {
  id: string;
  event_type: string;
  name: string;
  filter_json: string | Record<string, unknown> | null;
  action_type: 'WEBHOOK' | 'SLACK' | 'EMAIL' | 'WORKFLOW';
  action_config: string | Record<string, unknown>;
  active: number;
}

export interface PlatformEventPayload {
  empId: string;
  initiatedBy?: string;
  context?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseJsonField<T extends Record<string, unknown>>(
  raw: string | T | null,
): T | null {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function postJson(url: string, body: Record<string, unknown>, secret?: string): Promise<void> {
  const payload = JSON.stringify(body);
  const parsed = new URL(url);
  const lib = parsed.protocol === 'https:' ? https : http;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(payload)),
    'User-Agent': 'Lenskart-IdP-Events/1.0',
  };
  if (secret) headers['X-IdP-Signature'] = secret;

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
          reject(new Error(`HTTP ${res.statusCode}`));
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

async function fireTrigger(
  trigger: EventTriggerRow,
  eventType: string,
  payload: PlatformEventPayload,
): Promise<void> {
  const config = parseJsonField(trigger.action_config) ?? {};
  const eventBody = {
    eventType,
    empId: payload.empId,
    initiatedBy: payload.initiatedBy,
    context: payload.context ?? {},
    triggerId: trigger.id,
    triggerName: trigger.name,
    timestamp: new Date().toISOString(),
  };

  switch (trigger.action_type) {
    case 'WEBHOOK':
    case 'SLACK': {
      const url = (config['url'] as string) ?? (config['target_url'] as string);
      if (!url) throw new Error('Trigger action_config missing url');
      await postJson(url, eventBody, config['secret'] as string | undefined);
      break;
    }
    case 'EMAIL': {
      const recipient = (config['recipientEmpId'] as string) ?? payload.empId;
      await sendNotification({
        recipientEmpId: recipient,
        channel: 'EMAIL',
        subject: (config['subject'] as string) ?? `Event: ${eventType}`,
        body: (config['body'] as string) ?? JSON.stringify(eventBody, null, 2),
        referenceType: 'EVENT_TRIGGER',
        referenceId: trigger.id,
      });
      break;
    }
    case 'WORKFLOW': {
      const workflowId = config['workflowId'] as string | undefined;
      if (!workflowId) throw new Error('WORKFLOW trigger missing action_config.workflowId');
      await runWorkflowsForEvent(eventType, payload.empId, {
        ...(payload.initiatedBy !== undefined ? { initiatedBy: payload.initiatedBy } : {}),
        payload: { ...(payload.context ?? {}), linkedWorkflowId: workflowId },
      });
      break;
    }
    default:
      throw new Error(`Unsupported action_type: ${trigger.action_type}`);
  }

  await execute(
    `UPDATE event_triggers
        SET last_fired_at = UTC_TIMESTAMP(), fire_count = fire_count + 1
      WHERE id = ?`,
    [trigger.id],
  );
}

// ---------------------------------------------------------------------------
// dispatchPlatformEvent
// ---------------------------------------------------------------------------
export async function dispatchPlatformEvent(
  eventType: string,
  payload: PlatformEventPayload,
): Promise<void> {
  const log = logger.child({ eventType, empId: payload.empId });

  const triggers = await query<EventTriggerRow>(
    `SELECT id, event_type, name, filter_json, action_type, action_config, active
       FROM event_triggers
      WHERE active = 1 AND event_type = ?
      ORDER BY name`,
    [eventType],
  );

  for (const trigger of triggers) {
    try {
      await fireTrigger(trigger, eventType, payload);
      log.info({ triggerId: trigger.id, action: trigger.action_type }, 'Event trigger fired');
    } catch (err) {
      log.error({ triggerId: trigger.id, err }, 'Event trigger failed');
    }
  }

  try {
    const runIds = await runWorkflowsForEvent(eventType, payload.empId, {
      ...(payload.initiatedBy !== undefined ? { initiatedBy: payload.initiatedBy } : {}),
      ...(payload.context !== undefined ? { payload: payload.context } : {}),
    });
    if (runIds.length > 0) {
      log.info({ runIds }, 'Workflows started for event');
    }
  } catch (err) {
    log.error({ err }, 'Workflow dispatch failed');
  }
}

/** Fire-and-forget wrapper — never blocks the caller. */
export function emitPlatformEvent(eventType: string, payload: PlatformEventPayload): void {
  void dispatchPlatformEvent(eventType, payload).catch((err) => {
    logger.error({ eventType, empId: payload.empId, err }, 'emitPlatformEvent failed');
  });
}
