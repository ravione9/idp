/**
 * User Lifecycle Service
 * ----------------------
 * Handles suspend, unsuspend, and terminate operations for employees.
 * - Revokes all active sessions (DB + Redis)
 * - Enqueues outbox ops to downstream identity systems
 * - Records lifecycle events in the lifecycle_events table
 * - Writes to the audit log
 */

import { query, queryOne, execute } from '../db/connection.js';
import { enqueueOutboxOps, getIdentityLinksForEmp } from '../utils/outbox.js';
import { redis } from '../auth/session-store.js';
import { appendAuditLog } from '../utils/audit-log.js';
import { EmployeeStateMachine } from '../fsm/employee-state-machine.js';
import { ILGState, TransitionActor, TransitionOrigin, isPortalAccessible, isValidTransition } from '../fsm/states.js';
import { emitPlatformEvent } from './event-dispatcher.js';
import { propagatePortalDisableToAd, propagatePortalEnableToAd } from './connector-adapters.js';
import { revokeAllUserAppAccess } from './app-access-policy.js';
import logger from '../utils/logger.js';

const fsm = new EmployeeStateMachine();

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

  if (emp.ilg_state === ILGState.SUSPENDED_HR) {
    logger.info({ empId }, 'suspendUser: employee already SUSPENDED_HR, skipping');
    return;
  }

  const oldState = emp.ilg_state;

  if (isValidTransition(oldState as ILGState, ILGState.SUSPENDED_HR)) {
    await fsm.transition({
      empId,
      toState: ILGState.SUSPENDED_HR,
      actor: TransitionActor.ADMIN,
      actorId: initiatedBy,
      origin: TransitionOrigin.LILG,
      reasonCode: reason,
      evidence: { action: 'USER_SUSPEND' },
    });
  } else {
    await execute(
      'UPDATE employees SET ilg_state = ?, ilg_state_since = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE emp_id = ?',
      [ILGState.SUSPENDED_HR, empId],
    );
    const links = await getIdentityLinksForEmp(empId);
    const activeLinks = links.filter((l) => l.status === 'ACTIVE');
    if (activeLinks.length > 0) {
      await enqueueOutboxOps(
        empId,
        activeLinks.map((l) => ({
          system: l.system,
          op: 'DISABLE',
          payload: { externalId: l.external_id },
          priority: 'HIGH' as const,
        })),
      );
    }
  }

  await revokeAllSessions(empId);

  await revokeAllUserAppAccess({
    empId,
    revokedBy: initiatedBy,
    source: 'USER_SUSPEND',
    reason,
  }).catch((err) => logger.warn({ empId, err }, 'suspendUser: app access revoke failed'));

  await propagatePortalDisableToAd(empId).catch((err) =>
    logger.warn({ empId, err }, 'suspendUser: immediate AD disable failed'),
  );

  await query(
    `INSERT INTO lifecycle_events (emp_id, event_type, old_state, new_state, reason, initiated_by)
     VALUES (?, 'SUSPEND', ?, ?, ?, ?)`,
    [empId, oldState, ILGState.SUSPENDED_HR, reason, initiatedBy],
  );

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

  await propagatePortalEnableToAd(empId).catch((err) =>
    logger.warn({ empId, err }, 'unsuspendUser: immediate AD enable failed'),
  );

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

  await revokeAllUserAppAccess({
    empId,
    revokedBy: initiatedBy,
    source: 'USER_TERMINATE',
    reason,
  }).catch((err) => logger.warn({ empId, err }, 'terminateUser: app access revoke failed'));

  await propagatePortalDisableToAd(empId).catch((err) =>
    logger.warn({ empId, err }, 'terminateUser: immediate AD disable failed'),
  );

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

// ---------------------------------------------------------------------------
// Directory sync — propagate disable/enable from AD / Google within sync cycle
// ---------------------------------------------------------------------------

/** Suspend portal access when AD or Google marks a user disabled (sets ilg_state_since for 24h cleanup). */
export async function applyDirectorySourceDisabled(
  empId: string,
  source: 'AD' | 'GOOGLE',
  reason: string,
): Promise<void> {
  const emp = await queryOne<{ emp_id: string; ilg_state: string }>(
    'SELECT emp_id, ilg_state FROM employees WHERE emp_id = ?',
    [empId],
  );
  if (!emp) return;

  if (!isPortalAccessible(emp.ilg_state)) {
    logger.debug({ empId, source, ilg_state: emp.ilg_state }, 'Directory disable: already suspended, skipping side effects');
    return;
  }

  await fsm.transition({
    empId,
    toState: ILGState.SUSPENDED_AUTO,
    actor: TransitionActor.SYSTEM,
    actorId: 'directory-sync',
    origin: TransitionOrigin.EXTERNAL,
    reasonCode: `DIRECTORY_DISABLED:${source}`,
    evidence: { source, reason },
  });

  await revokeAllSessions(empId);

  await revokeAllUserAppAccess({
    empId,
    revokedBy: 'directory-sync',
    source: 'DIRECTORY_DISABLE',
    reason: `${source}:${reason}`,
  }).catch((err) => logger.warn({ empId, source, err }, 'Directory disable: app access revoke failed'));

  logger.info({ empId, source, ilg_state: emp.ilg_state }, 'Directory source disabled — portal and app access revoked');
}

/** Re-enable portal access when directory source reports user active again (does not override admin suspend). */
export async function applyDirectorySourceEnabled(
  empId: string,
  source: 'AD' | 'GOOGLE',
): Promise<void> {
  const emp = await queryOne<{ emp_id: string; ilg_state: string }>(
    'SELECT emp_id, ilg_state FROM employees WHERE emp_id = ?',
    [empId],
  );
  if (!emp || emp.ilg_state !== ILGState.SUSPENDED_AUTO) return;

  await fsm.transition({
    empId,
    toState: ILGState.ACTIVE,
    actor: TransitionActor.SYSTEM,
    actorId: 'directory-sync',
    origin: TransitionOrigin.EXTERNAL,
    reasonCode: `DIRECTORY_ENABLED:${source}`,
    evidence: { source },
  });

  logger.info({ empId, source }, 'Directory source enabled — employee reactivated');
}

/** Whether inbound sync should preserve a non-active admin/terminal state. */
export function preserveIlgStateOnDirectoryImport(currentState: string): string {
  if (
    currentState === ILGState.SUSPENDED_HR
    || currentState === ILGState.DEPARTED
    || currentState === ILGState.DEPROVISIONED
    || currentState === ILGState.PENDING_MGR
    || currentState === ILGState.ESCALATED_HRBP
  ) {
    return currentState;
  }
  return ILGState.ACTIVE;
}

// ---------------------------------------------------------------------------
// deprovisionUser — remove from application and enqueue DELETE to directories
// ---------------------------------------------------------------------------
export async function deprovisionUser(empId: string, reason: string, initiatedBy: string): Promise<void> {
  const emp = await queryOne<{ emp_id: string; ilg_state: string }>(
    'SELECT emp_id, ilg_state FROM employees WHERE emp_id = ?',
    [empId],
  );

  if (!emp) {
    throw new Error('Employee not found');
  }

  if (emp.ilg_state === ILGState.DEPROVISIONED) {
    logger.info({ empId }, 'deprovisionUser: employee already DEPROVISIONED, skipping');
    return;
  }

  const oldState = emp.ilg_state;
  const fromState = oldState as ILGState;

  if (!isValidTransition(fromState, ILGState.DEPROVISIONED)) {
    if (isValidTransition(fromState, ILGState.SUSPENDED_HR)) {
      await fsm.transition({
        empId,
        toState: ILGState.SUSPENDED_HR,
        actor: TransitionActor.SYSTEM,
        actorId: initiatedBy,
        origin: TransitionOrigin.LILG,
        reasonCode: `${reason}:pre_deprovision`,
      });
    } else if (isValidTransition(fromState, ILGState.SUSPENDED_AUTO)) {
      await fsm.transition({
        empId,
        toState: ILGState.SUSPENDED_AUTO,
        actor: TransitionActor.SYSTEM,
        actorId: initiatedBy,
        origin: TransitionOrigin.LILG,
        reasonCode: `${reason}:pre_deprovision`,
      });
    }
  }

  await fsm.transition({
    empId,
    toState: ILGState.DEPROVISIONED,
    actor: TransitionActor.SYSTEM,
    actorId: initiatedBy,
    origin: TransitionOrigin.LILG,
    reasonCode: reason,
    evidence: { oldState },
  });

  await revokeAllSessions(empId);

  await revokeAllUserAppAccess({
    empId,
    revokedBy: initiatedBy,
    source: 'USER_DEPROVISION',
    reason,
  }).catch((err) => logger.warn({ empId, err }, 'deprovisionUser: app access revoke failed'));

  await execute('UPDATE local_accounts SET active = 0 WHERE emp_id = ?', [empId]);

  await query(
    `INSERT INTO lifecycle_events (emp_id, event_type, old_state, new_state, reason, initiated_by)
     VALUES (?, 'DEPROVISION', ?, ?, ?, ?)`,
    [empId, oldState, ILGState.DEPROVISIONED, reason, initiatedBy],
  );

  await appendAuditLog(
    initiatedBy,
    'USER_DEPROVISION',
    `employee:${empId}`,
    { empId, reason, oldState, newState: ILGState.DEPROVISIONED },
  ).catch((err) => logger.warn({ err }, 'Failed to write audit log for USER_DEPROVISION'));

  emitPlatformEvent('LEAVER', { empId, initiatedBy, context: { reason, oldState } });

  logger.info({ empId, oldState, initiatedBy }, 'Employee deprovisioned');
}
