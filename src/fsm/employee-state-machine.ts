import { query, queryOne, transaction } from '../db/connection.js';
import {
  ILGState,
  TransitionActor,
  TransitionOrigin,
  isValidTransition,
  getOutboxOpsForTransition,
} from './states.js';
import { enqueueOutboxOps, getIdentityLinksForEmp } from '../utils/outbox.js';
import { appendAuditLog } from '../utils/audit-log.js';
import { emitPlatformEvent } from '../services/event-dispatcher.js';
import { revokeAllUserAppAccess } from '../services/app-access-policy.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface Employee {
  emp_id: string;
  ilg_state: ILGState;
  version: bigint;
  full_name: string;
}

interface TransitionParams {
  empId: string;
  toState: ILGState;
  actor: TransitionActor;
  actorId: string;
  origin: TransitionOrigin;
  reasonCode: string;
  evidence?: Record<string, unknown>;
  workflowRunId?: string;
}

// ---------------------------------------------------------------------------
// EmployeeStateMachine
// ---------------------------------------------------------------------------
export class EmployeeStateMachine {
  /**
   * Atomically transitions an employee to a new ILG state.
   *
   * Steps:
   *  1. SELECT employee FOR UPDATE (pessimistic lock)
   *  2. Validate FSM transition is legal
   *  3. Optimistic version check
   *  4. INSERT into state_transitions
   *  5. UPDATE employees ilg_state + version + ilg_state_since
   *  6. Enqueue adapter outbox operations for all active identity links
   *  7. Append tamper-evident audit log entry
   *
   * All DB writes occur inside a single serializable transaction.
   */
  async transition(params: TransitionParams): Promise<void> {
    const {
      empId,
      toState,
      actor,
      actorId,
      origin,
      reasonCode,
      evidence = {},
      workflowRunId = uuidv4(),
    } = params;

    const log = logger.child({ empId, toState, actor, actorId, workflowRunId });

    let committedFromState: ILGState | null = null;

    await transaction(async (conn) => {
      // -----------------------------------------------------------------------
      // 1. Lock the employee row
      // -----------------------------------------------------------------------
      const employees = await query<Employee>(
        'SELECT emp_id, ilg_state, version, full_name FROM employees WHERE emp_id = ? FOR UPDATE',
        [empId],
        conn,
      );

      if (employees.length === 0) {
        throw new Error(`Employee not found: ${empId}`);
      }

      const emp = employees[0];
      const fromState = emp.ilg_state;

      // -----------------------------------------------------------------------
      // 2. Validate FSM transition
      // -----------------------------------------------------------------------
      if (!isValidTransition(fromState, toState)) {
        throw new Error(
          `Invalid FSM transition for ${empId}: ${fromState} → ${toState}`,
        );
      }

      // No-op guard: idempotent re-apply of same state is a warning, not an error
      if (fromState === toState) {
        log.warn('No-op transition — employee already in target state');
        return;
      }

      // -----------------------------------------------------------------------
      // 3. Read current version (already in emp.version) — no external claim to
      //    check here, but we bump version atomically below.
      // -----------------------------------------------------------------------
      const currentVersion = Number(emp.version);

      // -----------------------------------------------------------------------
      // 4. INSERT state_transitions record
      // -----------------------------------------------------------------------
      await query(
        `INSERT INTO state_transitions
           (emp_id, from_state, to_state, reason_code, evidence, actor, actor_id, origin, ts, workflow_run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), ?)`,
        [
          empId,
          fromState,
          toState,
          reasonCode,
          JSON.stringify(evidence),
          actor,
          actorId,
          origin,
          workflowRunId,
        ],
        conn,
      );

      // -----------------------------------------------------------------------
      // 5. UPDATE employees — state, version, state_since
      // -----------------------------------------------------------------------
      const updateResult = await query<{ affectedRows: number }>(
        `UPDATE employees
            SET ilg_state = ?,
                ilg_state_since = UTC_TIMESTAMP(),
                version = version + 1,
                updated_at = UTC_TIMESTAMP()
          WHERE emp_id = ?
            AND version = ?`,
        [toState, empId, currentVersion],
        conn,
      );

      // Type-safe check on affectedRows from mysql2 ResultSetHeader
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const affectedRows = (updateResult as any).affectedRows ?? 0;
      if (affectedRows === 0) {
        throw new Error(
          `Optimistic lock failure for ${empId} at version ${currentVersion}. Another writer modified the record concurrently.`,
        );
      }

      // -----------------------------------------------------------------------
      // 6. Enqueue adapter outbox operations
      // -----------------------------------------------------------------------
      const ops = getOutboxOpsForTransition(toState);
      if (ops.length > 0) {
        const links = await getIdentityLinksForEmp(empId, conn);
        const outboxEntries = links.flatMap((link) =>
          ops.map((op) => ({
            system: link.system,
            op,
            payload: {
              externalId: link.external_id,
              empId,
              fromState,
              toState,
              reasonCode,
              workflowRunId,
            },
            priority: toState === ILGState.DEPROVISIONED || toState === ILGState.DEPARTED
              ? ('HIGH' as const)
              : ('NORMAL' as const),
          })),
        );

        if (outboxEntries.length > 0) {
          await enqueueOutboxOps(empId, outboxEntries, conn);
        }
      }

      // -----------------------------------------------------------------------
      // 7. Append audit log (within same transaction connection)
      // -----------------------------------------------------------------------
      await appendAuditLog(
        actorId,
        `FSM_TRANSITION:${fromState}->${toState}`,
        `employee:${empId}`,
        {
          empId,
          fromState,
          toState,
          reasonCode,
          evidence,
          actor,
          origin,
          workflowRunId,
          version: currentVersion + 1,
        },
        conn,
      );

      log.info({ fromState, toState, version: currentVersion + 1 }, 'FSM transition committed');
      committedFromState = fromState;
    });

    if (committedFromState) {
      const platformEvent = mapFsmToPlatformEvent(committedFromState, toState);
      if (platformEvent) {
        emitPlatformEvent(platformEvent, {
          empId,
          initiatedBy: actorId,
          context: { fromState: committedFromState, toState, reasonCode, origin },
        });
      }

      if (
        toState === ILGState.SUSPENDED_AUTO
        || toState === ILGState.SUSPENDED_HR
        || toState === ILGState.DEPARTED
        || toState === ILGState.DEPROVISIONED
      ) {
        void revokeAllUserAppAccess({
          empId,
          revokedBy: actorId,
          source: `FSM:${toState}`,
          reason: reasonCode,
        }).catch((err) =>
          log.warn({ err }, 'FSM transition: application access revoke failed'),
        );
      }
    }
  }

  /**
   * Convenience: batch-transition multiple employees to the same state.
   * Each employee is processed independently — failures are collected, not thrown.
   */
  async batchTransition(
    empIds: string[],
    toState: ILGState,
    actor: TransitionActor,
    actorId: string,
    origin: TransitionOrigin,
    reasonCode: string,
    evidence?: Record<string, unknown>,
  ): Promise<{ succeeded: string[]; failed: Array<{ empId: string; error: string }> }> {
    const succeeded: string[] = [];
    const failed: Array<{ empId: string; error: string }> = [];

    await Promise.all(
      empIds.map(async (empId) => {
        try {
          await this.transition({
            empId,
            toState,
            actor,
            actorId,
            origin,
            reasonCode,
            ...(evidence !== undefined ? { evidence } : {}),
          });
          succeeded.push(empId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failed.push({ empId, error: message });
          logger.error({ empId, toState, error: message }, 'Batch FSM transition failed');
        }
      }),
    );

    return { succeeded, failed };
  }

  /**
   * Read the current ILG state of an employee (read-only, no lock).
   */
  async getCurrentState(empId: string): Promise<ILGState | null> {
    const row = await queryOne<{ ilg_state: ILGState }>(
      'SELECT ilg_state FROM employees WHERE emp_id = ?',
      [empId],
    );
    return row?.ilg_state ?? null;
  }
}

function mapFsmToPlatformEvent(fromState: ILGState, toState: ILGState): string | null {
  if (toState === ILGState.DEPARTED || toState === ILGState.DEPROVISIONED) return 'LEAVER';
  if (toState === ILGState.SUSPENDED_HR || toState === ILGState.SUSPENDED_AUTO) return 'SUSPEND';
  if (
    (toState === ILGState.ACTIVE || toState === ILGState.REACTIVATED) &&
    (fromState === ILGState.SUSPENDED_HR ||
      fromState === ILGState.SUSPENDED_AUTO ||
      fromState === ILGState.PENDING_MGR ||
      fromState === ILGState.ESCALATED_HRBP ||
      fromState === ILGState.DEPARTED ||
      fromState === ILGState.DEPROVISIONED)
  ) {
    return 'JOINER';
  }
  return null;
}
