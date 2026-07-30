/**
 * LILG Risk Engine
 * ----------------
 * Evaluates per-employee activity signals and decides whether to trigger
 * a state-machine transition (SUSPEND or ESCALATE).
 *
 * Algorithm:
 *   1. For each ACTIVE employee:
 *      a. Fetch last N working days from activity_aggregate
 *      b. Check consecutive no-signal runs
 *      c. Store employees: check store-wide degraded fraction circuit breaker
 *   2. 3 consecutive no-signal working days  → SUSPENDED_AUTO
 *   3. 7 consecutive no-signal working days  → ESCALATED_HRBP (via PENDING_MGR)
 */

import { query, queryOne } from '../db/connection.js';
import { EmployeeStateMachine } from '../fsm/employee-state-machine.js';
import { ILGState, TransitionActor, TransitionOrigin } from '../fsm/states.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface ActivityRow {
  date: string;
  expected_to_work: number; // MySQL BOOL → 0|1
  has_attendance:   number;
  has_leave:        number;
}

interface EmployeeRow {
  emp_id:           string;
  ilg_state:        ILGState;
  employment_type:  string;
  state:            string | null;
}

type RiskAction = 'SUSPEND' | 'ESCALATE' | 'OK' | 'SKIP';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SUSPEND_THRESHOLD   = 3;
const ESCALATE_THRESHOLD  = 7;
/** If more than this fraction of store employees have no signal, skip (store network issue) */
const STORE_SKIP_FRACTION = 0.05;

// ---------------------------------------------------------------------------
// RiskEngine class
// ---------------------------------------------------------------------------
export class RiskEngine {
  private readonly fsm = new EmployeeStateMachine();

  /**
   * Fetch the last N working days for an employee, ordered most-recent first.
   */
  async getWorkingDays(empId: string, lastN: number): Promise<ActivityRow[]> {
    return query<ActivityRow>(
      `SELECT date, expected_to_work, has_attendance, has_leave
         FROM activity_aggregate
        WHERE emp_id = ?
          AND expected_to_work = 1
        ORDER BY date DESC
        LIMIT ?`,
      [empId, lastN],
    );
  }

  /**
   * Check whether store-level circuit breaker should suppress risk evaluation.
   * Returns true if more than STORE_SKIP_FRACTION of store employees had no signal today.
   */
  async isStoreDegraded(state: string | null): Promise<boolean> {
    if (!state) return false;

    const today = todayYmd();

    const result = await queryOne<{ total: number; no_signal: number }>(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN aa.has_attendance = 0 AND aa.has_leave = 0 THEN 1 ELSE 0 END) AS no_signal
         FROM employees e
         JOIN activity_aggregate aa ON aa.emp_id = e.emp_id AND aa.date = ?
        WHERE e.employment_type = 'STORE'
          AND e.state = ?
          AND e.ilg_state = 'ACTIVE'`,
      [today, state],
    );

    if (!result || result.total === 0) return false;
    const fraction = result.no_signal / result.total;
    return fraction > STORE_SKIP_FRACTION;
  }

  /**
   * Evaluate a single employee and return the recommended action.
   */
  async evaluateEmployee(emp: EmployeeRow): Promise<{ action: RiskAction; consecutiveDays: number }> {
    // Store circuit breaker
    if (emp.employment_type === 'STORE') {
      const degraded = await this.isStoreDegraded(emp.state);
      if (degraded) {
        return { action: 'SKIP', consecutiveDays: 0 };
      }
    }

    // Fetch enough days to cover both thresholds
    const days = await this.getWorkingDays(emp.emp_id, ESCALATE_THRESHOLD);

    // Count consecutive no-signal from the most recent day backwards
    let consecutive = 0;
    for (const day of days) {
      const hasSignal = day.has_attendance === 1 || day.has_leave === 1;
      if (hasSignal) break;
      consecutive++;
    }

    if (consecutive >= ESCALATE_THRESHOLD) {
      return { action: 'ESCALATE', consecutiveDays: consecutive };
    }
    if (consecutive >= SUSPEND_THRESHOLD) {
      return { action: 'SUSPEND', consecutiveDays: consecutive };
    }

    return { action: 'OK', consecutiveDays: consecutive };
  }

  /**
   * Scan all ACTIVE employees and apply FSM transitions where needed.
   * Returns a summary of actions taken.
   */
  async scanAll(): Promise<{ scanned: number; suspended: number; escalated: number; skipped: number; errors: number }> {
    const employees = await query<EmployeeRow>(
      `SELECT emp_id, ilg_state, employment_type, state
         FROM employees
        WHERE ilg_state = 'ACTIVE'
        ORDER BY emp_id`,
      [],
    );

    let suspended = 0;
    let escalated = 0;
    let skipped   = 0;
    let errors    = 0;

    await Promise.all(employees.map(async (emp) => {
      try {
        const { action, consecutiveDays } = await this.evaluateEmployee(emp);

        switch (action) {
          case 'SUSPEND':
            await this.fsm.transition({
              empId:      emp.emp_id,
              toState:    ILGState.SUSPENDED_AUTO,
              actor:      TransitionActor.SYSTEM,
              actorId:    'risk-engine',
              origin:     TransitionOrigin.LILG,
              reasonCode: 'RISK_NO_SIGNAL_3D',
              evidence:   { consecutiveDays, evaluatedAt: new Date().toISOString() },
            });
            suspended++;
            logger.info({ empId: emp.emp_id, consecutiveDays }, 'Risk: employee suspended (3-day no-signal)');
            break;

          case 'ESCALATE':
            // Transition through PENDING_MGR first if coming from ACTIVE,
            // then immediately escalate to HRBP
            await this.fsm.transition({
              empId:      emp.emp_id,
              toState:    ILGState.PENDING_MGR,
              actor:      TransitionActor.SYSTEM,
              actorId:    'risk-engine',
              origin:     TransitionOrigin.LILG,
              reasonCode: 'RISK_NO_SIGNAL_7D_MGR',
              evidence:   { consecutiveDays, evaluatedAt: new Date().toISOString() },
            });
            await this.fsm.transition({
              empId:      emp.emp_id,
              toState:    ILGState.ESCALATED_HRBP,
              actor:      TransitionActor.SYSTEM,
              actorId:    'risk-engine',
              origin:     TransitionOrigin.LILG,
              reasonCode: 'RISK_NO_SIGNAL_7D_HRBP',
              evidence:   { consecutiveDays, evaluatedAt: new Date().toISOString() },
            });
            escalated++;
            logger.warn({ empId: emp.emp_id, consecutiveDays }, 'Risk: employee escalated to HRBP (7-day no-signal)');
            break;

          case 'SKIP':
            skipped++;
            logger.debug({ empId: emp.emp_id }, 'Risk: evaluation skipped (store degraded)');
            break;

          case 'OK':
            // No action needed
            break;
        }
      } catch (err) {
        errors++;
        logger.error({ empId: emp.emp_id, err }, 'Risk: evaluation failed');
      }
    }));

    logger.info(
      { scanned: employees.length, suspended, escalated, skipped, errors },
      'Risk scan complete',
    );

    return { scanned: employees.length, suspended, escalated, skipped, errors };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}
