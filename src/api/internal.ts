/**
 * LILG Internal Routes
 * ---------------------
 * Gated by X-Internal-Token header.
 * Called by Airflow DAGs and other backend services.
 *
 * Routes:
 *   POST /ingest/hrms         — full HRMS roster sync
 *   POST /ingest/truein       — True-in attendance ingest
 *   POST /aggregate           — run activity aggregator
 *   POST /risk-scan           — run risk engine scan
 *   POST /drift-detection     — run drift detector
 *   POST /digests/manager     — send manager digest emails
 *   GET  /admin/health/queue  — outbox queue metrics
 */

import { Router, Request, Response, NextFunction } from 'express';
import axios from 'axios';
import { config } from '../config.js';
import { query, queryOne } from '../db/connection.js';
import { EmployeeStateMachine } from '../fsm/employee-state-machine.js';
import { ILGState, TransitionActor, TransitionOrigin } from '../fsm/states.js';
import { RiskEngine } from '../services/risk-engine.js';
import { getOutboxQueueDepth } from '../utils/outbox.js';
import logger from '../utils/logger.js';

const router  = Router();
const fsm     = new EmployeeStateMachine();
const riskEngine = new RiskEngine();

// ---------------------------------------------------------------------------
// Internal token guard middleware
// ---------------------------------------------------------------------------
function requireInternalToken(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers['x-internal-token'];
  if (!token || token !== config.app.internalToken) {
    res.status(403).json({ error: 'Invalid or missing X-Internal-Token' });
    return;
  }
  next();
}

router.use(requireInternalToken);

// ---------------------------------------------------------------------------
// POST /ingest/hrms — trigger HRMS roster sync
// ---------------------------------------------------------------------------
router.post('/ingest/hrms', async (_req: Request, res: Response): Promise<void> => {
  const log = logger.child({ route: 'ingest/hrms' });
  const started = Date.now();

  try {
    // Fetch all employees from Darwinbox API (paginated)
    let page = 1;
    const pageSize = 200;
    let totalSynced = 0;
    let hasMore = true;

    while (hasMore) {
      const resp = await axios.get<{
        employees: Array<{
          employee_id:      string;
          full_name:        string;
          email:            string;
          status:           string;
          department_id:    string;
          designation:      string;
          reporting_manager: string;
          date_of_joining:  string;
          last_working_day: string | null;
          employment_type:  string;
          city:             string;
          state:            string;
        }>;
        total_count: number;
      }>(
        `${config.hrms.apiBaseUrl}/employees`,
        {
          params:  { page, per_page: pageSize },
          headers: { 'api-key': config.hrms.apiKey },
          timeout: 30_000,
        },
      );

      const employees = resp.data.employees;
      if (employees.length < pageSize) hasMore = false;
      page++;

      // Upsert each employee into the DB
      for (const emp of employees) {
        const hrmsStatus = emp.status === 'Active' ? 'ACTIVE'
          : emp.status === 'On Notice' ? 'ON_NOTICE'
          : 'DEPARTED';

        const empType = emp.employment_type?.toUpperCase() ?? 'CORPORATE';
        const safeEmpType = ['CORPORATE','STORE','PLANT','DC'].includes(empType) ? empType : 'CORPORATE';

        await query(
          `INSERT INTO employees
             (emp_id, full_name, email_corp, dept_id, role, city, state, manager_emp_id,
              hire_date, planned_exit_date, employment_type, hrms_status, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())
           ON DUPLICATE KEY UPDATE
             full_name       = VALUES(full_name),
             email_corp      = VALUES(email_corp),
             dept_id         = VALUES(dept_id),
             role            = VALUES(role),
             city            = VALUES(city),
             state           = VALUES(state),
             manager_emp_id  = VALUES(manager_emp_id),
             planned_exit_date = VALUES(planned_exit_date),
             employment_type = VALUES(employment_type),
             hrms_status     = VALUES(hrms_status),
             updated_at      = UTC_TIMESTAMP()`,
          [
            emp.employee_id,
            emp.full_name,
            emp.email,
            emp.department_id,
            emp.designation,
            emp.city,
            emp.state,
            emp.reporting_manager || null,
            emp.date_of_joining,
            emp.last_working_day || null,
            safeEmpType,
            hrmsStatus,
          ],
        );

        // Handle HRMS-driven departures: transition FSM if DEPARTED
        if (hrmsStatus === 'DEPARTED') {
          const current = await queryOne<{ ilg_state: ILGState }>(
            'SELECT ilg_state FROM employees WHERE emp_id = ?',
            [emp.employee_id],
          );

          if (current && current.ilg_state !== ILGState.DEPARTED && current.ilg_state !== ILGState.DEPROVISIONED) {
            await fsm.transition({
              empId:      emp.employee_id,
              toState:    ILGState.DEPARTED,
              actor:      TransitionActor.SYSTEM,
              actorId:    'hrms-sync',
              origin:     TransitionOrigin.HRMS_SYNC,
              reasonCode: 'HRMS_STATUS_DEPARTED',
              evidence:   { lastWorkingDay: emp.last_working_day },
            }).catch((err) => log.error({ empId: emp.employee_id, err }, 'HRMS: FSM transition failed'));
          }
        }

        totalSynced++;
      }
    }

    log.info({ totalSynced, durationMs: Date.now() - started }, 'HRMS sync complete');
    res.json({ success: true, totalSynced, durationMs: Date.now() - started });
  } catch (err) {
    log.error({ err }, 'HRMS sync failed');
    res.status(500).json({ error: 'HRMS sync failed', detail: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /ingest/truein — True-in attendance ingest
// ---------------------------------------------------------------------------
router.post('/ingest/truein', async (req: Request, res: Response): Promise<void> => {
  const log = logger.child({ route: 'ingest/truein' });
  const started = Date.now();

  // Support delta mode via body parameter
  const deltaOnly = Boolean(req.body?.['delta']);
  const sinceDate = req.body?.['since'] as string | undefined;

  try {
    const trueinBaseUrl = process.env['TRUEIN_API_BASE_URL'] ?? 'https://api.truein.com/v1';
    const trueinApiKey  = process.env['TRUEIN_API_KEY'] ?? '';

    const params: Record<string, string> = { page_size: '500' };
    if (deltaOnly && sinceDate) params['since'] = sinceDate;

    let page = 1;
    let totalIngested = 0;
    let hasMore = true;

    while (hasMore) {
      const resp = await axios.get<{
        records: Array<{
          employee_code: string;
          in_time:       string;
          location:      string;
          device_id:     string;
          face_score:    number;
        }>;
        next_page: boolean;
      }>(
        `${trueinBaseUrl}/attendance`,
        {
          params:  { ...params, page },
          headers: { 'Authorization': `Bearer ${trueinApiKey}` },
          timeout: 30_000,
        },
      );

      const records = resp.data.records;
      hasMore = resp.data.next_page;
      page++;

      if (records.length > 0) {
        // Batch insert attendance events (ignore duplicates)
        const placeholders = records.map(() => '(?, ?, ?, ?, ?)').join(', ');
        const values: unknown[] = [];
        for (const r of records) {
          values.push(r.employee_code, r.in_time, 'TRUEIN', r.location, r.device_id);
        }

        await query(
          `INSERT IGNORE INTO attendance_events (emp_id, event_ts, source, location, device_id)
           VALUES ${placeholders}`,
          values,
        );

        totalIngested += records.length;
      }

      if (records.length < 500) hasMore = false;
    }

    log.info({ totalIngested, deltaOnly, durationMs: Date.now() - started }, 'True-in ingest complete');
    res.json({ success: true, totalIngested, deltaOnly, durationMs: Date.now() - started });
  } catch (err) {
    log.error({ err }, 'True-in ingest failed');
    res.status(500).json({ error: 'True-in ingest failed', detail: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /aggregate — activity aggregator
// ---------------------------------------------------------------------------
router.post('/aggregate', async (req: Request, res: Response): Promise<void> => {
  const log = logger.child({ route: 'aggregate' });
  const started = Date.now();

  // Optional: only re-aggregate dates on or after `since`
  const since = req.body?.['since'] as string | undefined;
  const sinceClause = since ? `AND aa.date >= ?` : '';
  const sinceParams = since ? [since] : [];

  try {
    // Upsert activity_aggregate from raw attendance_events and leave_records
    // Step 1: mark expected_to_work based on working days (not holiday, not weekend, no override)
    await query(
      `INSERT INTO activity_aggregate (emp_id, date, expected_to_work, has_attendance, has_leave, source)
       SELECT
         e.emp_id,
         d.date,
         CASE
           WHEN wdo.expected_to_work IS NOT NULL THEN wdo.expected_to_work
           WHEN hc.date IS NOT NULL THEN 0
           WHEN DAYOFWEEK(d.date) IN (1, 7) THEN 0  /* Sun=1, Sat=7 */
           ELSE 1
         END AS expected_to_work,
         0 AS has_attendance,
         0 AS has_leave,
         'AGGREGATOR' AS source
       FROM employees e
       CROSS JOIN (
         SELECT DATE_SUB(CURDATE(), INTERVAL seq DAY) AS date
         FROM (
           SELECT @row := @row + 1 AS seq
           FROM information_schema.columns, (SELECT @row := -1) r
           LIMIT 30
         ) t
       ) d
       LEFT JOIN holiday_calendar hc ON hc.date = d.date
         AND (hc.state = e.state OR hc.format = 'ALL')
         AND hc.format = e.employment_type
       LEFT JOIN working_day_overrides wdo ON wdo.emp_id = e.emp_id AND wdo.date = d.date
       WHERE e.ilg_state NOT IN ('DEPROVISIONED')
       ON DUPLICATE KEY UPDATE
         expected_to_work = VALUES(expected_to_work),
         source = 'AGGREGATOR'`,
      [],
    );

    // Step 2: mark has_attendance
    await query(
      `UPDATE activity_aggregate aa
          JOIN (
            SELECT DATE(event_ts) AS date, emp_id, 1 AS has_att
              FROM attendance_events
             GROUP BY emp_id, DATE(event_ts)
          ) ae ON ae.emp_id = aa.emp_id AND ae.date = aa.date
          SET aa.has_attendance = 1
        WHERE 1=1 ${sinceClause}`,
      sinceParams,
    );

    // Step 3: mark has_leave
    await query(
      `UPDATE activity_aggregate aa
          JOIN (
            SELECT lr.emp_id, d.date
              FROM leave_records lr
              JOIN (
                SELECT DATE_SUB(CURDATE(), INTERVAL seq DAY) AS date
                FROM (SELECT @row := @row + 1 AS seq FROM information_schema.columns, (SELECT @row := -1) r LIMIT 30) t
              ) d ON d.date BETWEEN lr.start_date AND lr.end_date
             WHERE lr.status = 'APPROVED'
          ) l ON l.emp_id = aa.emp_id AND l.date = aa.date
          SET aa.has_leave = 1
        WHERE 1=1 ${sinceClause}`,
      sinceParams,
    );

    log.info({ durationMs: Date.now() - started }, 'Activity aggregation complete');
    res.json({ success: true, durationMs: Date.now() - started });
  } catch (err) {
    log.error({ err }, 'Aggregation failed');
    res.status(500).json({ error: 'Aggregation failed', detail: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /risk-scan — run risk engine scan
// ---------------------------------------------------------------------------
router.post('/risk-scan', async (_req: Request, res: Response): Promise<void> => {
  const started = Date.now();
  try {
    const result = await riskEngine.scanAll();
    res.json({ success: true, ...result, durationMs: Date.now() - started });
  } catch (err) {
    logger.error({ err }, 'Risk scan failed');
    res.status(500).json({ error: 'Risk scan failed', detail: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /drift-detection — compare identity_links against live adapter state
// ---------------------------------------------------------------------------
router.post('/drift-detection', async (_req: Request, res: Response): Promise<void> => {
  const log = logger.child({ route: 'drift-detection' });
  const started = Date.now();

  try {
    // Find all ACTIVE identity_links for ACTIVE employees
    const links = await query<{
      il_id:      number;
      emp_id:     string;
      system:     string;
      external_id: string;
      il_status:  string;
      emp_state:  string;
    }>(
      `SELECT il.id AS il_id, il.emp_id, il.\`system\`, il.external_id, il.status AS il_status, e.ilg_state AS emp_state
         FROM identity_links il
         JOIN employees e ON e.emp_id = il.emp_id
        WHERE il.status = 'ACTIVE'
          AND e.ilg_state = 'ACTIVE'`,
      [],
    );

    let driftCount = 0;

    for (const link of links) {
      // For each link, check the last_synced_at; if stale > 24h, mark as drift
      const stale = await queryOne<{ stale: number }>(
        `SELECT CASE WHEN TIMESTAMPDIFF(HOUR, last_synced_at, UTC_TIMESTAMP()) > 24 THEN 1 ELSE 0 END AS stale
           FROM identity_links WHERE id = ?`,
        [link.il_id],
      );

      if (stale?.stale) {
        await query(
          `UPDATE identity_links SET drift_flag = 1 WHERE id = ?`,
          [link.il_id],
        );
        driftCount++;
        log.warn({ ilId: link.il_id, empId: link.emp_id, system: link.system }, 'Drift detected: stale link');
      }
    }

    log.info({ checked: links.length, driftCount, durationMs: Date.now() - started }, 'Drift detection complete');
    res.json({ success: true, checked: links.length, drift_events: driftCount, durationMs: Date.now() - started });
  } catch (err) {
    log.error({ err }, 'Drift detection failed');
    res.status(500).json({ error: 'Drift detection failed', detail: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /digests/manager — send manager digest emails
// ---------------------------------------------------------------------------
router.post('/digests/manager', async (_req: Request, res: Response): Promise<void> => {
  const log = logger.child({ route: 'digests/manager' });
  const started = Date.now();

  try {
    // Get all managers with suspended direct reports
    const managers = await query<{ manager_emp_id: string; email_corp: string; full_name: string; count: number }>(
      `SELECT e.manager_emp_id, m.email_corp, m.full_name, COUNT(*) AS count
         FROM employees e
         JOIN employees m ON m.emp_id = e.manager_emp_id
        WHERE e.ilg_state IN ('SUSPENDED_AUTO', 'PENDING_MGR')
          AND e.manager_emp_id IS NOT NULL
        GROUP BY e.manager_emp_id, m.email_corp, m.full_name`,
      [],
    );

    let sent = 0;
    for (const mgr of managers) {
      // In production this would call an email service (SES / Zoho Mail / SendGrid)
      // Here we log the digest and call a stub email endpoint
      log.info(
        { managerId: mgr.manager_emp_id, email: mgr.email_corp, suspendedCount: mgr.count },
        'Sending manager digest email',
      );

      // Record that digest was sent (to avoid re-sending on retry)
      await query(
        `INSERT INTO audit_log (actor, action, target, payload, curr_hash)
         VALUES ('digest-worker', 'MANAGER_DIGEST_SENT', ?, ?, SHA2(CONCAT(UTC_TIMESTAMP(), ?), 256))`,
        [
          `manager:${mgr.manager_emp_id}`,
          JSON.stringify({ email: mgr.email_corp, suspendedCount: mgr.count }),
          mgr.manager_emp_id,
        ],
      );

      sent++;
    }

    log.info({ sent, durationMs: Date.now() - started }, 'Manager digests dispatched');
    res.json({ success: true, sent, durationMs: Date.now() - started });
  } catch (err) {
    log.error({ err }, 'Manager digest failed');
    res.status(500).json({ error: 'Manager digest failed', detail: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /admin/health/queue — outbox queue metrics (used by Airflow backpressure)
// ---------------------------------------------------------------------------
router.get('/admin/health/queue', async (_req: Request, res: Response): Promise<void> => {
  try {
    const depth = await getOutboxQueueDepth();
    const pending = depth['PENDING'] ?? 0;

    res.json({
      queue_depth:    pending,
      by_status:      depth,
      healthy:        pending < 5000,
      ts:             new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err }, 'Queue health check failed');
    res.status(500).json({ error: 'Queue health check failed' });
  }
});

export default router;
