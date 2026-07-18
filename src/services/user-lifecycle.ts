/**
 * User Lifecycle Service
 * ----------------------
 * Handles suspend, unsuspend, and terminate operations for employees.
 * - Revokes all active sessions (DB + Redis)
 * - Enqueues outbox ops to downstream identity systems
 * - Records lifecycle events in the lifecycle_events table
 * - Writes to the audit log
 */

import { query, queryOne } from '../db/connection.js';
import { enqueueOutboxOps, getIdentityLinksForEmp } from '../utils/outbox.js';
import { redis } from '../auth/session-store.js';
import { appendAuditLog } from '../utils/audit-log.js';
import { ILGState } from '../fsm/states.js';
import { emitPlatformEvent } from './event-dispatcher.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function revokeAllSessions(empId: string): Promise<void> {
  const sessions = await query<{ session_id: string }>(
    'SELECT session_id FROM idp_sessions WHERE emp_id = ? AND revoked_at IS NULL',
    [empId],
  );

  if (sessions.length > 0) {
    await query(
      'UPDATE idp_sessions SET revoked_at = UTC_TIMESTAMP() WHERE emp_id = ? AND revoked_at IS NULL',
      [empId],
    );

    for (const s of sessions) {
      await redis.del(`idp:session:${s.session_id}`).catch((err) =>
        logger.warn({ sessionId: s.session_id, err }, 'Failed to delete session from Redis'),
      );
    }

    logger.info({ empId, count: sessions.length }, 'Revoked all active sessions');
  }
}

// ---------------------------------------------------------------------------
// suspendUser
// ---------------------------------------------------------------------------
export async function suspendUser(empId: string, reason: string, initiatedBy: string): Promise<void> {
  const emp = await queryOne<{ emp_id: string; ilg_state: string }>(
    'SELECT emp_id, ilg_state FROM employees WHERE emp_id = ?',
    [empId],
  );

  if (!emp) {
    throw new Error('Employee not found');
  }

  // Idempotent: already suspended
  if (emp.ilg_state === ILGState.SUSPENDED_HR) {
    logger.info({ empId }, 'suspendUser: employee already SUSPENDED_HR, skipping');
    return;
  }

  const oldState = emp.ilg_state;

  // Update employee state
  await query(
    'UPDATE employees SET ilg_state = ?, updated_at = UTC_TIMESTAMP() WHERE emp_id = ?',
    [ILGState.SUSPENDED_HR, empId],
  );

  // Revoke sessions
  await revokeAllSessions(empId);

  // Enqueue DISABLE outbox ops for all active identity links
  const links = await getIdentityLinksForEmp(empId);
  const activeLinks = links.filter((l) => l.status === 'ACTIVE');

  if (activeLinks.length > 0) {
    await enqueueOutboxOps(
      empId,
      activeLinks.map((l) => ({
        system:   l.system,
        op:       'DISABLE',
        payload:  { externalId: l.external_id },
        priority: 'HIGH' as const,
      })),
    );
  }

  // Record lifecycle event
  await query(
    `INSERT INTO lifecycle_events (emp_id, event_type, old_state, new_state, reason, initiated_by)
     VALUES (?, 'SUSPEND', ?, ?, ?, ?)`,
    [empId, oldState, ILGState.SUSPENDED_HR, reason, initiatedBy],
  );

  // Write audit log
  await appendAuditLog(
    initiatedBy,
    'USER_SUSPEND',
    `employee:${empId}`,
    { empId, reason, oldState, newState: ILGState.SUSPENDED_HR },
  ).catch((err) => logger.warn({ err }, 'Failed to write audit log for USER_SUSPEND'));

  emitPlatformEvent('SUSPEND', { empId, initiatedBy, context: { reason, oldState } });

  logger.info({ empId, oldState, initiatedBy }, 'Employee suspended');
}

// ---------------------------------------------------------------------------
// unsuspendUser
// ---------------------------------------------------------------------------
export async function unsuspendUser(empId: string, reason: string, initiatedBy: string): Promise<void> {
  const emp = await queryOne<{ emp_id: string; ilg_state: string }>(
    'SELECT emp_id, ilg_state FROM employees WHERE emp_id = ?',
    [empId],
  );

  if (!emp) {
    throw new Error('Employee not found');
  }

  // Idempotent: only unsuspend if currently admin-suspended
  if (emp.ilg_state !== ILGState.SUSPENDED_HR) {
    logger.info({ empId, ilg_state: emp.ilg_state }, 'unsuspendUser: employee is not SUSPENDED_HR, skipping');
    return;
  }

  const oldState = emp.ilg_state;

  // Update employee state
  await query(
    'UPDATE employees SET ilg_state = ?, updated_at = UTC_TIMESTAMP() WHERE emp_id = ?',
    [ILGState.ACTIVE, empId],
  );

  // Enqueue ENABLE outbox ops for all identity links
  const links = await getIdentityLinksForEmp(empId);

  if (links.length > 0) {
    await enqueueOutboxOps(
      empId,
      links.map((l) => ({
        system:   l.system,
        op:       'ENABLE',
        payload:  { externalId: l.external_id },
        priority: 'HIGH' as const,
      })),
    );
  }

  // Record lifecycle event
  await query(
    `INSERT INTO lifecycle_events (emp_id, event_type, old_state, new_state, reason, initiated_by)
     VALUES (?, 'UNSUSPEND', ?, ?, ?, ?)`,
    [empId, oldState, ILGState.ACTIVE, reason, initiatedBy],
  );

  // Write audit log
  await appendAuditLog(
    initiatedBy,
    'USER_UNSUSPEND',
    `employee:${empId}`,
    { empId, reason, oldState, newState: ILGState.ACTIVE },
  ).catch((err) => logger.warn({ err }, 'Failed to write audit log for USER_UNSUSPEND'));

  emitPlatformEvent('UNSUSPEND', { empId, initiatedBy, context: { reason, oldState } });

  logger.info({ empId, initiatedBy }, 'Employee unsuspended');
}

// ---------------------------------------------------------------------------
// terminateUser
// ---------------------------------------------------------------------------
export async function terminateUser(empId: string, reason: string, initiatedBy: string): Promise<void> {
  const emp = await queryOne<{ emp_id: string; ilg_state: string }>(
    'SELECT emp_id, ilg_state FROM employees WHERE emp_id = ?',
    [empId],
  );

  if (!emp) {
    throw new Error('Employee not found');
  }

  // Idempotent: already departed
  if (emp.ilg_state === ILGState.DEPARTED || emp.ilg_state === ILGState.DEPROVISIONED) {
    logger.info({ empId, ilg_state: emp.ilg_state }, 'terminateUser: employee already departed, skipping');
    return;
  }

  const oldState = emp.ilg_state;

  // Update employee state
  await query(
    'UPDATE employees SET ilg_state = ?, updated_at = UTC_TIMESTAMP() WHERE emp_id = ?',
    [ILGState.DEPARTED, empId],
  );

  // Revoke all sessions
  await revokeAllSessions(empId);

  // Enqueue DISABLE + REVOKE_TOKENS + REVOKE_BINDINGS for all active identity links
  const links = await getIdentityLinksForEmp(empId);
  const activeLinks = links.filter((l) => l.status === 'ACTIVE');

  if (activeLinks.length > 0) {
    const outboxOps = activeLinks.flatMap((l) => [
      { system: l.system, op: 'DISABLE',         payload: { externalId: l.external_id }, priority: 'HIGH' as const },
      { system: l.system, op: 'REVOKE_TOKENS',   payload: { externalId: l.external_id }, priority: 'HIGH' as const },
      { system: l.system, op: 'REVOKE_BINDINGS', payload: { externalId: l.external_id }, priority: 'HIGH' as const },
    ]);
    await enqueueOutboxOps(empId, outboxOps);
  }

  // Record lifecycle event
  await query(
    `INSERT INTO lifecycle_events (emp_id, event_type, old_state, new_state, reason, initiated_by)
     VALUES (?, 'TERMINATE', ?, ?, ?, ?)`,
    [empId, oldState, ILGState.DEPARTED, reason, initiatedBy],
  );

  // Write audit log
  await appendAuditLog(
    initiatedBy,
    'USER_TERMINATE',
    `employee:${empId}`,
    { empId, reason, oldState, newState: ILGState.DEPARTED },
  ).catch((err) => logger.warn({ err }, 'Failed to write audit log for USER_TERMINATE'));

  emitPlatformEvent('LEAVER', { empId, initiatedBy, context: { reason, oldState } });

  logger.info({ empId, oldState, initiatedBy }, 'Employee terminated');
}
