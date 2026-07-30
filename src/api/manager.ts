import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../db/connection.js';
import { requireAuth } from '../auth/middleware.js';
import { requireRole, getEmployeeScope } from '../auth/rbac.js';
import { EmployeeStateMachine } from '../fsm/employee-state-machine.js';
import { ILGState, TransitionActor, TransitionOrigin } from '../fsm/states.js';
import logger from '../utils/logger.js';

const router  = Router();
const fsm     = new EmployeeStateMachine();

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------
const reactivateSchema = z.object({
  empId:      z.string().min(1),
  reasonCode: z.string().min(1).default('MGR_VOUCHES_ACTIVE'),
  note:       z.string().max(500).optional(),
});

const rejectSchema = z.object({
  empId:      z.string().min(1),
  reasonCode: z.string().min(1).default('MGR_UNABLE_TO_VERIFY'),
  note:       z.string().max(500).optional(),
});

// ---------------------------------------------------------------------------
// GET /manager/queue
// Queue of SUSPENDED_AUTO employees within the manager's scope,
// enriched with last 7 days of activity evidence.
// ---------------------------------------------------------------------------
router.get(
  '/queue',
  requireAuth,
  requireRole('MANAGER', 'HRBP', 'ADMIN', 'SUPER_ADMIN'),
  async (req: Request, res: Response): Promise<void> => {
    const scope = getEmployeeScope(req);

    const suspended = await query<{
      emp_id:          string;
      full_name:       string;
      email_corp:      string;
      employment_type: string;
      ilg_state_since: string;
    }>(
      `SELECT e.emp_id, e.full_name, e.email_corp, e.employment_type, e.ilg_state_since
         FROM employees e
        WHERE e.ilg_state IN ('SUSPENDED_AUTO', 'PENDING_MGR')
          AND (${scope.sql})
        ORDER BY e.ilg_state_since ASC`,
      scope.params,
    );

    // Enrich each employee with last 7 working days of activity
    const enriched = await Promise.all(
      suspended.map(async (emp) => {
        const activity = await query<{
          date:            string;
          expected_to_work: number;
          has_attendance:  number;
          has_leave:       number;
        }>(
          `SELECT date, expected_to_work, has_attendance, has_leave
             FROM activity_aggregate
            WHERE emp_id = ?
              AND expected_to_work = 1
            ORDER BY date DESC
            LIMIT 7`,
          [emp.emp_id],
        );

        const consecutiveNoSignal = (() => {
          let count = 0;
          for (const day of activity) {
            if (day.has_attendance || day.has_leave) break;
            count++;
          }
          return count;
        })();

        return { ...emp, activity, consecutiveNoSignal };
      }),
    );

    res.json({ data: enriched, total: enriched.length });
  },
);

// ---------------------------------------------------------------------------
// POST /manager/reactivate
// Manager vouches for an employee — transition to REACTIVATED.
// ---------------------------------------------------------------------------
router.post(
  '/reactivate',
  requireAuth,
  requireRole('MANAGER', 'ADMIN', 'SUPER_ADMIN'),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = reactivateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
      return;
    }

    const { empId, reasonCode, note } = parsed.data;
    const actor = req.user!;

    // Verify the employee is within the manager's scope
    const scope = getEmployeeScope(req);
    if (scope.sql !== '1=1') {
      const [{ allowed }] = await query<{ allowed: number }>(
        `SELECT COUNT(*) AS allowed FROM employees e WHERE e.emp_id = ? AND (${scope.sql})`,
        [empId, ...scope.params],
      );
      if (!allowed) {
        res.status(403).json({ error: 'Employee is outside your management scope' });
        return;
      }
    }

    // Verify current state is SUSPENDED_AUTO or PENDING_MGR
    const emp = await queryOne<{ ilg_state: ILGState }>(
      'SELECT ilg_state FROM employees WHERE emp_id = ?',
      [empId],
    );

    if (!emp) {
      res.status(404).json({ error: 'Employee not found' });
      return;
    }

    if (![ILGState.SUSPENDED_AUTO, ILGState.PENDING_MGR].includes(emp.ilg_state)) {
      res.status(409).json({
        error:        'Employee is not in a state that can be reactivated by a manager',
        currentState: emp.ilg_state,
      });
      return;
    }

    await fsm.transition({
      empId,
      toState:    ILGState.REACTIVATED,
      actor:      TransitionActor.MANAGER,
      actorId:    actor.empId,
      origin:     TransitionOrigin.LILG,
      reasonCode,
      evidence:   { managerNote: note, managerId: actor.empId, managerEmail: actor.email },
    });

    logger.info({ empId, managerId: actor.empId, reasonCode }, 'Manager reactivated employee');
    res.json({ success: true, empId, newState: ILGState.REACTIVATED });
  },
);

// ---------------------------------------------------------------------------
// POST /manager/reject
// Manager cannot vouch — escalate to HRBP.
// ---------------------------------------------------------------------------
router.post(
  '/reject',
  requireAuth,
  requireRole('MANAGER', 'ADMIN', 'SUPER_ADMIN'),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = rejectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
      return;
    }

    const { empId, reasonCode, note } = parsed.data;
    const actor = req.user!;

    // Scope check
    const scope = getEmployeeScope(req);
    if (scope.sql !== '1=1') {
      const [{ allowed }] = await query<{ allowed: number }>(
        `SELECT COUNT(*) AS allowed FROM employees e WHERE e.emp_id = ? AND (${scope.sql})`,
        [empId, ...scope.params],
      );
      if (!allowed) {
        res.status(403).json({ error: 'Employee is outside your management scope' });
        return;
      }
    }

    const emp = await queryOne<{ ilg_state: ILGState }>(
      'SELECT ilg_state FROM employees WHERE emp_id = ?',
      [empId],
    );

    if (!emp) {
      res.status(404).json({ error: 'Employee not found' });
      return;
    }

    if (![ILGState.SUSPENDED_AUTO, ILGState.PENDING_MGR].includes(emp.ilg_state)) {
      res.status(409).json({
        error:        'Employee cannot be escalated from current state',
        currentState: emp.ilg_state,
      });
      return;
    }

    // First move to PENDING_MGR if still in SUSPENDED_AUTO
    if (emp.ilg_state === ILGState.SUSPENDED_AUTO) {
      await fsm.transition({
        empId,
        toState:    ILGState.PENDING_MGR,
        actor:      TransitionActor.MANAGER,
        actorId:    actor.empId,
        origin:     TransitionOrigin.LILG,
        reasonCode: 'MGR_ACKNOWLEDGED',
        evidence:   { managerId: actor.empId },
      });
    }

    await fsm.transition({
      empId,
      toState:    ILGState.ESCALATED_HRBP,
      actor:      TransitionActor.MANAGER,
      actorId:    actor.empId,
      origin:     TransitionOrigin.LILG,
      reasonCode,
      evidence:   { managerNote: note, managerId: actor.empId, managerEmail: actor.email },
    });

    logger.info({ empId, managerId: actor.empId, reasonCode }, 'Manager escalated employee to HRBP');
    res.json({ success: true, empId, newState: ILGState.ESCALATED_HRBP });
  },
);

export default router;
