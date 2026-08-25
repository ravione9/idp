/**
 * Application Access Policy — user/tag-group assignments, workflow config, audit.
 */

import { v4 as uuidv4 } from 'uuid';
import { query, queryOne, execute } from '../db/connection.js';
import logger from '../utils/logger.js';
import { canReceiveSamlAssertion, evaluateEntitlement } from '../saml/entitlements.js';
import type { EmployeeSamlContext, EntitlementRule } from '../saml/types.js';
import { ipInAllowlist, parseCidrList } from '../utils/ip-match.js';
import { provisionAppUser, deprovisionAppUser } from './app-scim-provision.js';

export type AssignmentType = 'USER' | 'TAG_GROUP' | 'GROUP';
export type AuditAction =
  | 'ASSIGN_USER' | 'ASSIGN_GROUP' | 'REVOKE'
  | 'REQUEST' | 'APPROVE' | 'REJECT' | 'PROVISION';

export interface ApprovalLevel {
  level: number;
  approverType: 'MANAGER' | 'APP_OWNER' | 'ADMIN' | 'SPECIFIC';
  approverEmpId?: string;
}

export interface WorkflowRow {
  id: string;
  app_id: string;
  tag_group_id: string | null;
  name: string;
  approval_levels: string;
  requester_group_ids?: string | unknown | null;
  auto_provision: number;
  active: number;
}

// ---------------------------------------------------------------------------
// Assignable application catalog (mirrors SAML SPs into applications)
// ---------------------------------------------------------------------------
/**
 * Ensure a SAML SP exists in `applications` as RESTRICTED so Access Policy grants
 * are required. Called on SSO / launch so new SPs cannot fall open before an admin
 * opens the Assignments UI.
 */
export async function ensureSamlAppMirrored(slug: string): Promise<void> {
  const sp = await queryOne<{
    slug: string;
    name: string;
    icon_url: string | null;
    sort_order: number;
    active: number;
  }>(
    `SELECT slug, name, icon_url, sort_order, active
       FROM saml_service_providers WHERE slug = ? LIMIT 1`,
    [slug],
  );
  if (!sp) return;

  const existing = await queryOne<{ id: string; visibility: string }>(
    `SELECT id, visibility FROM applications WHERE slug = ? LIMIT 1`,
    [slug],
  );
  if (!existing) {
    await execute(
      `INSERT INTO applications
         (id, slug, name, icon_url, category, visibility, sso_enabled, provisioning, sort_order, active)
       VALUES (?, ?, ?, ?, 'SSO', 'RESTRICTED', 1, 0, ?, ?)`,
      [uuidv4(), sp.slug, sp.name, sp.icon_url, sp.sort_order ?? 0, sp.active ? 1 : 0],
    );
    logger.info({ slug }, 'Mirrored SAML SP into applications catalog as RESTRICTED');
    return;
  }

  // SAML apps must stay grant-gated — PUBLIC + all_active was bypassing group assignments.
  if (existing.visibility !== 'RESTRICTED') {
    await execute(
      `UPDATE applications SET visibility = 'RESTRICTED' WHERE id = ?`,
      [existing.id],
    );
    logger.info({ slug }, 'Forced SAML-linked application visibility to RESTRICTED');
  }
}

export async function syncSamlAppsToCatalog(): Promise<number> {
  const sps = await query<{
    slug: string;
    name: string;
    icon_url: string | null;
    sort_order: number;
    active: number;
  }>(
    `SELECT slug, name, icon_url, sort_order, active
       FROM saml_service_providers`,
    [],
  );

  let touched = 0;
  for (const sp of sps) {
    const before = await queryOne<{ id: string; visibility: string }>(
      `SELECT id, visibility FROM applications WHERE slug = ?`,
      [sp.slug],
    );
    await ensureSamlAppMirrored(sp.slug);
    const after = await queryOne<{ id: string; visibility: string }>(
      `SELECT id, visibility FROM applications WHERE slug = ?`,
      [sp.slug],
    );
    if (!before || before.visibility !== after?.visibility) touched += 1;
  }

  if (touched > 0) {
    logger.info({ touched }, 'Synced SAML service providers into applications catalog');
  }
  return touched;
}

export async function listAssignableApplications(): Promise<Record<string, unknown>[]> {
  await syncSamlAppsToCatalog();
  const rows = await query<Record<string, unknown>>(
    `SELECT a.id, a.slug, a.name, a.icon_url, a.category, a.active, a.allowed_cidrs,
            EXISTS (
              SELECT 1 FROM saml_service_providers sp WHERE sp.slug = a.slug AND sp.active = 1
            ) AS has_saml
       FROM applications a
      WHERE a.active = 1
      ORDER BY a.sort_order ASC, a.name ASC`,
    [],
  );
  return rows.map((r) => ({
    ...r,
    allowed_cidrs: parseCidrList(r['allowed_cidrs']),
  }));
}

export async function setApplicationAllowedCidrs(
  appId: string,
  cidrs: string[],
): Promise<void> {
  const app = await queryOne<{ id: string }>(
    `SELECT id FROM applications WHERE id = ? LIMIT 1`,
    [appId],
  );
  if (!app) throw new Error('Application not found');
  const cleaned = parseCidrList(cidrs);
  await execute(
    `UPDATE applications SET allowed_cidrs = ? WHERE id = ?`,
    [cleaned.length ? JSON.stringify(cleaned) : null, appId],
  );
  logger.info({ appId, count: cleaned.length }, 'Updated application IP allowlist');
}

export async function getApplicationAllowedCidrs(appSlug: string): Promise<string[]> {
  const row = await queryOne<{ allowed_cidrs: unknown }>(
    `SELECT allowed_cidrs FROM applications WHERE slug = ? AND active = 1 LIMIT 1`,
    [appSlug],
  );
  return parseCidrList(row?.allowed_cidrs);
}

/** True when the app has no IP allowlist, or the client IP matches it. */
export async function isClientIpAllowedForApp(
  appSlug: string,
  clientIp: string | undefined | null,
): Promise<boolean> {
  const cidrs = await getApplicationAllowedCidrs(appSlug);
  if (!cidrs.length) return true;
  if (!clientIp || clientIp === 'unknown') return false;
  return ipInAllowlist(clientIp, cidrs);
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------
export async function logAppAccessAudit(params: {
  appId?: string | null;
  action: AuditAction;
  actorEmpId?: string | null;
  targetEmpId?: string | null;
  tagGroupId?: string | null;
  requestId?: string | null;
  details?: Record<string, unknown>;
}): Promise<void> {
  await execute(
    `INSERT INTO app_access_audit_log
       (app_id, action, actor_emp_id, target_emp_id, tag_group_id, request_id, details)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      params.appId ?? null,
      params.action,
      params.actorEmpId ?? null,
      params.targetEmpId ?? null,
      params.tagGroupId ?? null,
      params.requestId ?? null,
      params.details ? JSON.stringify(params.details) : null,
    ],
  ).catch((err) => logger.warn({ err, action: params.action }, 'Failed to write app access audit'));
}

// ---------------------------------------------------------------------------
// Policy-based app access check (used by SAML launcher + /api/apps)
// ---------------------------------------------------------------------------
/** True when launch requires an explicit Application Access Policy grant. */
export async function appRequiresExplicitGrant(appSlug: string): Promise<boolean> {
  // Active SAML SPs always require a USER / GROUP / TAG_GROUP assignment.
  // Entitlement-rule birthright alone must not grant SSO (that bypassed Access Policy).
  const saml = await queryOne<{ ok: number }>(
    `SELECT 1 AS ok FROM saml_service_providers WHERE slug = ? AND active = 1 LIMIT 1`,
    [appSlug],
  );
  if (saml) {
    await ensureSamlAppMirrored(appSlug);
    return true;
  }

  const row = await queryOne<{ visibility: string; has_assignments: number }>(
    `SELECT a.visibility,
            EXISTS (
              SELECT 1 FROM app_access_assignments x
               WHERE x.app_id = a.id AND x.active = 1
            ) AS has_assignments
       FROM applications a
      WHERE a.slug = ? AND a.active = 1
      LIMIT 1`,
    [appSlug],
  );
  if (!row) return false;
  if (row.visibility === 'RESTRICTED') return true;
  return (row.has_assignments ?? 0) === 1;
}

export type AppLaunchDenyReason = 'ILG_STATE' | 'NO_GRANT' | 'IP_DENIED' | 'ERROR';

export interface AppLaunchDecision {
  allowed: boolean;
  reason?: AppLaunchDenyReason;
}

export interface AppLaunchOptions {
  /** Client public IP — used only when enforceIp is true. */
  clientIp?: string | null;
  /**
   * When true, verify client IP against applications.allowed_cidrs after grant.
   * Catalog listing must leave this false so apps stay visible; SSO launch sets true.
   */
  enforceIp?: boolean;
}

export async function evaluateAppLaunch(
  emp: EmployeeSamlContext,
  slug: string,
  rule: EntitlementRule | null,
  opts?: AppLaunchOptions,
): Promise<AppLaunchDecision> {
  if (!canReceiveSamlAssertion(emp)) {
    return { allowed: false, reason: 'ILG_STATE' };
  }

  try {
    const requiresGrant = await appRequiresExplicitGrant(slug);
    const policyAccess = await hasPolicyAppAccess(emp.emp_id, slug);
    let entitled = false;
    if (requiresGrant) {
      if (!policyAccess) {
        logger.info(
          { empId: emp.emp_id, slug },
          'SSO denied — no Application Access Policy grant',
        );
        return { allowed: false, reason: 'NO_GRANT' };
      }
      entitled = true;
    } else {
      // Non-SAML catalog apps only: optional birthright via entitlement_rule.
      entitled = policyAccess || evaluateEntitlement(emp, rule);
      if (!entitled) return { allowed: false, reason: 'NO_GRANT' };
    }

    // IP allowlist is enforced at launch time only — never hide the app tile.
    if (opts?.enforceIp) {
      const ipOk = await isClientIpAllowedForApp(slug, opts.clientIp);
      if (!ipOk) {
        logger.info(
          { empId: emp.emp_id, slug, ip: opts.clientIp ?? null },
          'SSO denied — client IP not in application allowlist',
        );
        return { allowed: false, reason: 'IP_DENIED' };
      }
    }

    return { allowed: true };
  } catch (err) {
    // Fail closed — never fall back to open entitlement on policy errors.
    logger.warn({ err, empId: emp.emp_id, slug }, 'App access policy check failed; denying launch');
    return { allowed: false, reason: 'ERROR' };
  }
}

export async function canUserLaunchApp(
  emp: EmployeeSamlContext,
  slug: string,
  rule: EntitlementRule | null,
  opts?: AppLaunchOptions,
): Promise<boolean> {
  const decision = await evaluateAppLaunch(emp, slug, rule, opts);
  return decision.allowed;
}

export async function hasPolicyAppAccess(empId: string, appSlug: string): Promise<boolean> {
  const row = await queryOne<{ ok: number }>(
    `SELECT 1 AS ok
       FROM applications a
      WHERE a.slug = ? AND a.active = 1
        AND (
          EXISTS (
            SELECT 1 FROM app_access_assignments x
             WHERE x.app_id = a.id AND x.active = 1
               AND x.assignment_type = 'USER'
               AND x.target_id COLLATE utf8mb4_unicode_ci = ? COLLATE utf8mb4_unicode_ci
          )
          OR EXISTS (
            SELECT 1 FROM app_access_assignments x
              JOIN tag_group_members tgm
                ON tgm.tag_group_id COLLATE utf8mb4_unicode_ci = x.target_id COLLATE utf8mb4_unicode_ci
             WHERE x.app_id = a.id AND x.active = 1
               AND x.assignment_type = 'TAG_GROUP'
               AND tgm.emp_id COLLATE utf8mb4_unicode_ci = ? COLLATE utf8mb4_unicode_ci
          )
          OR EXISTS (
            SELECT 1 FROM app_access_assignments x
              JOIN group_members gm
                ON gm.group_id COLLATE utf8mb4_unicode_ci = x.target_id COLLATE utf8mb4_unicode_ci
             WHERE x.app_id = a.id AND x.active = 1
               AND x.assignment_type = 'GROUP'
               AND gm.emp_id COLLATE utf8mb4_unicode_ci = ? COLLATE utf8mb4_unicode_ci
          )
        )
      LIMIT 1`,
    [appSlug, empId, empId, empId],
  );
  // mysql2 may return TINYINT/Buffer — coerce before comparing
  return Number(row?.ok ?? 0) === 1;
}

/**
 * Mark PENDING access requests past their SLA / validity as EXPIRED and wipe
 * pending approvals from approver queues (decision → SKIPPED).
 * Call with no args for a global sweep. Returns how many requests were expired.
 */
export async function expireStaleAccessRequests(empId?: string, appId?: string): Promise<number> {
  const params: unknown[] = [];
  let where = `
    status = 'PENDING'
    AND (
      (sla_due_at IS NOT NULL AND sla_due_at < UTC_TIMESTAMP())
      OR (valid_until IS NOT NULL AND valid_until < UTC_TIMESTAMP())
      OR (sla_due_at IS NULL AND valid_until IS NULL
          AND created_at < UTC_TIMESTAMP() - INTERVAL 3 DAY)
    )`;
  if (empId) {
    where += ' AND target_emp_id COLLATE utf8mb4_unicode_ci = ? COLLATE utf8mb4_unicode_ci';
    params.push(empId);
  }
  if (appId) {
    where += ` AND item_type = 'APP_ACCESS'
      AND (JSON_CONTAINS(item_ids, JSON_QUOTE(?), '$') OR CAST(item_ids AS CHAR) LIKE ?)`;
    params.push(appId, `%${appId}%`);
  }

  try {
    const stale = await query<{ id: string }>(
      `SELECT id FROM access_requests WHERE ${where}`,
      params,
    );

    let expiredCount = 0;
    if (stale.length) {
      const ids = stale.map((r) => r.id);
      const ph = ids.map(() => '?').join(', ');
      await execute(
        `UPDATE access_requests
            SET status = 'EXPIRED', decided_at = UTC_TIMESTAMP()
          WHERE id IN (${ph}) AND status = 'PENDING'`,
        ids,
      );
      await execute(
        `UPDATE access_request_approvals
            SET decision = 'SKIPPED', decided_at = UTC_TIMESTAMP(),
                comment = 'Auto-wiped — request expired (SLA elapsed)'
          WHERE request_id IN (${ph}) AND decision = 'PENDING'`,
        ids,
      );
      expiredCount = ids.length;
      logger.info({ count: ids.length, empId: empId ?? null, appId: appId ?? null }, 'Expired stale access requests');
    }

    // Orphan cleanup: approvals still PENDING on already-EXPIRED/CANCELLED requests
    const orphanWhere = empId
      ? `ar.target_emp_id COLLATE utf8mb4_unicode_ci = ? COLLATE utf8mb4_unicode_ci AND `
      : '';
    const orphanParams: unknown[] = empId ? [empId] : [];
    const orphanResult = await execute(
      `UPDATE access_request_approvals a
         JOIN access_requests ar ON ar.id = a.request_id
          SET a.decision = 'SKIPPED',
              a.decided_at = UTC_TIMESTAMP(),
              a.comment = COALESCE(a.comment, 'Auto-wiped — parent request no longer pending')
        WHERE ${orphanWhere}
              a.decision = 'PENDING'
          AND ar.status IN ('EXPIRED', 'CANCELLED', 'REJECTED', 'FULFILLED', 'APPROVED')`,
      orphanParams,
    );
    const wipedOrphans = Number(orphanResult.affectedRows ?? 0);
    if (wipedOrphans > 0) {
      logger.info({ wipedOrphans }, 'Wiped orphan pending approvals on closed requests');
    }

    return expiredCount;
  } catch (err) {
    logger.warn({ err, empId, appId }, 'Failed to expire stale access requests');
    return 0;
  }
}

export type PendingAppAccessInfo = {
  requestId: string;
  slaDueAt: string | null;
  createdAt: string | null;
};

/** Active (non-expired) pending APP_ACCESS request for this user+app, if any. */
export async function getActivePendingAppAccessRequest(
  empId: string,
  appId: string,
): Promise<PendingAppAccessInfo | null> {
  await expireStaleAccessRequests(empId, appId);
  try {
    const row = await queryOne<{
      id: string;
      sla_due_at: string | null;
      created_at: string | null;
    }>(
      `SELECT id, sla_due_at, created_at
         FROM access_requests
        WHERE target_emp_id COLLATE utf8mb4_unicode_ci = ? COLLATE utf8mb4_unicode_ci
          AND item_type = 'APP_ACCESS'
          AND status = 'PENDING'
          AND (sla_due_at IS NULL OR sla_due_at >= UTC_TIMESTAMP())
          AND (valid_until IS NULL OR valid_until >= UTC_TIMESTAMP())
          AND (
            JSON_CONTAINS(item_ids, JSON_QUOTE(?), '$')
            OR CAST(item_ids AS CHAR) LIKE ?
          )
        ORDER BY created_at DESC
        LIMIT 1`,
      [empId, appId, `%${appId}%`],
    );
    if (!row) return null;
    return {
      requestId: row.id,
      slaDueAt: row.sla_due_at,
      createdAt: row.created_at,
    };
  } catch (err) {
    logger.warn({ err, empId, appId }, 'Pending APP_ACCESS lookup failed; treating as none');
    return null;
  }
}

/** True when the user already has a non-expired pending APP_ACCESS request for this app. */
export async function hasPendingAppAccessRequest(empId: string, appId: string): Promise<boolean> {
  return (await getActivePendingAppAccessRequest(empId, appId)) !== null;
}

export async function getPolicyGrantedAppSlugs(empId: string): Promise<string[]> {
  const rows = await query<{ slug: string }>(
    `SELECT DISTINCT a.slug
       FROM applications a
      WHERE a.active = 1
        AND (
          EXISTS (
            SELECT 1 FROM app_access_assignments x
             WHERE x.app_id = a.id AND x.active = 1
               AND x.assignment_type = 'USER' AND x.target_id = ?
          )
          OR EXISTS (
            SELECT 1 FROM app_access_assignments x
              JOIN tag_group_members tgm ON tgm.tag_group_id = x.target_id
             WHERE x.app_id = a.id AND x.active = 1
               AND x.assignment_type = 'TAG_GROUP' AND tgm.emp_id = ?
          )
          OR EXISTS (
            SELECT 1 FROM app_access_assignments x
              JOIN group_members gm ON gm.group_id = x.target_id
             WHERE x.app_id = a.id AND x.active = 1
               AND x.assignment_type = 'GROUP' AND gm.emp_id = ?
          )
        )`,
    [empId, empId, empId],
  );
  return rows.map((r) => r.slug);
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------
/** Resolve USER target to canonical emp_id (accepts emp_id, employee_number, or email). */
async function resolveActiveEmployeeId(target: string): Promise<string> {
  const raw = target.trim();
  if (!raw) throw new Error('Employee ID or email is required');
  if (raw.length > 255) throw new Error('Employee lookup value is too long');

  const emp = await queryOne<{ emp_id: string }>(
    `SELECT emp_id FROM employees
      WHERE ilg_state IN ('ACTIVE', 'REACTIVATED')
        AND (
          emp_id = ?
          OR employee_number = ?
          OR LOWER(email_corp) = LOWER(?)
        )
      ORDER BY
        CASE
          WHEN emp_id = ? THEN 0
          WHEN employee_number = ? THEN 1
          ELSE 2
        END
      LIMIT 1`,
    [raw, raw, raw, raw, raw],
  );
  if (!emp) {
    throw new Error(
      'Employee not found or not active — use emp_id, employee number, or corporate email',
    );
  }
  return emp.emp_id;
}

async function resolveAssignmentTarget(
  assignmentType: AssignmentType,
  targetId: string,
): Promise<string> {
  if (assignmentType === 'USER') {
    return resolveActiveEmployeeId(targetId);
  }
  if (assignmentType === 'GROUP') {
    const grp = await queryOne<{ id: string }>(
      `SELECT id FROM \`groups\` WHERE id = ? AND active = 1 LIMIT 1`,
      [targetId],
    );
    if (!grp) throw new Error('Identity group not found or inactive');
    return grp.id;
  }
  const tg = await queryOne<{ id: string }>(
    `SELECT id FROM tag_groups WHERE id = ? AND active = 1 LIMIT 1`,
    [targetId],
  );
  if (!tg) throw new Error('Tag group not found or inactive');
  return tg.id;
}

function actorIdForDb(empId: string): string {
  return empId.slice(0, 20);
}

export async function grantAppAccess(params: {
  appId: string;
  assignmentType: AssignmentType;
  targetId: string;
  grantedBy: string;
  source?: 'ADMIN' | 'REQUEST';
  requestId?: string;
}): Promise<string> {
  const app = await queryOne<{ id: string }>(
    `SELECT id FROM applications WHERE id = ? LIMIT 1`,
    [params.appId],
  );
  if (!app) throw new Error('Application not found');

  const targetId = await resolveAssignmentTarget(params.assignmentType, params.targetId);
  const grantedBy = actorIdForDb(params.grantedBy);

  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM app_access_assignments
      WHERE app_id = ? AND assignment_type = ? AND target_id = ?`,
    [params.appId, params.assignmentType, targetId],
  );

  if (existing) {
    await execute(
      `UPDATE app_access_assignments
          SET active = 1, granted_by = ?, granted_at = UTC_TIMESTAMP(),
              revoked_at = NULL, revoked_by = NULL
        WHERE id = ?`,
      [grantedBy, existing.id],
    );
    await logAppAccessAudit({
      appId: params.appId,
      action: params.assignmentType === 'USER' ? 'ASSIGN_USER' : 'ASSIGN_GROUP',
      actorEmpId: grantedBy,
      targetEmpId: params.assignmentType === 'USER' ? targetId : null,
      tagGroupId: params.assignmentType === 'TAG_GROUP' ? targetId : null,
      requestId: params.requestId ?? null,
      details: {
        source: params.source ?? 'ADMIN',
        assignmentId: existing.id,
        assignmentType: params.assignmentType,
        groupId: params.assignmentType === 'GROUP' ? targetId : undefined,
      },
    });
    if (params.assignmentType === 'USER') {
      void provisionAppUser({
        appId: params.appId,
        empId: targetId,
        actorEmpId: grantedBy,
        source: params.source ?? 'ADMIN',
        requestId: params.requestId ?? null,
      }).catch((err) => logger.warn({ err, appId: params.appId, empId: targetId }, 'App SCIM provision failed'));
    }
    return existing.id;
  }

  const id = uuidv4();
  await execute(
    `INSERT INTO app_access_assignments
       (id, app_id, assignment_type, target_id, active, granted_by, granted_at)
     VALUES (?, ?, ?, ?, 1, ?, UTC_TIMESTAMP())`,
    [id, params.appId, params.assignmentType, targetId, grantedBy],
  );

  await logAppAccessAudit({
    appId: params.appId,
    action: params.assignmentType === 'USER' ? 'ASSIGN_USER' : 'ASSIGN_GROUP',
    actorEmpId: grantedBy,
    targetEmpId: params.assignmentType === 'USER' ? targetId : null,
    tagGroupId: params.assignmentType === 'TAG_GROUP' ? targetId : null,
    requestId: params.requestId ?? null,
    details: {
      source: params.source ?? 'ADMIN',
      assignmentId: id,
      assignmentType: params.assignmentType,
      groupId: params.assignmentType === 'GROUP' ? targetId : undefined,
    },
  });

  if (params.assignmentType === 'USER') {
    void provisionAppUser({
      appId: params.appId,
      empId: targetId,
      actorEmpId: grantedBy,
      source: params.source ?? 'ADMIN',
      requestId: params.requestId ?? null,
    }).catch((err) => logger.warn({ err, appId: params.appId, empId: targetId }, 'App SCIM provision failed'));
  }

  return id;
}

export async function updateAppAccess(
  assignmentId: string,
  params: {
    appId: string;
    assignmentType: AssignmentType;
    targetId: string;
    updatedBy: string;
  },
): Promise<void> {
  const row = await queryOne<{
    app_id: string;
    assignment_type: AssignmentType;
    target_id: string;
    active: number;
  }>(
    `SELECT app_id, assignment_type, target_id, active
       FROM app_access_assignments WHERE id = ?`,
    [assignmentId],
  );
  if (!row || !row.active) throw new Error('Assignment not found');

  const app = await queryOne<{ id: string }>(
    `SELECT id FROM applications WHERE id = ? LIMIT 1`,
    [params.appId],
  );
  if (!app) throw new Error('Application not found');

  const targetId = await resolveAssignmentTarget(params.assignmentType, params.targetId);
  const updatedBy = actorIdForDb(params.updatedBy);

  const conflict = await queryOne<{ id: string }>(
    `SELECT id FROM app_access_assignments
      WHERE app_id = ? AND assignment_type = ? AND target_id = ? AND id <> ?`,
    [params.appId, params.assignmentType, targetId, assignmentId],
  );
  if (conflict) {
    throw new Error('An assignment for this application and target already exists');
  }

  const unchanged =
    row.app_id === params.appId &&
    row.assignment_type === params.assignmentType &&
    row.target_id === targetId;
  if (unchanged) return;

  await execute(
    `UPDATE app_access_assignments
        SET app_id = ?, assignment_type = ?, target_id = ?,
            granted_by = ?, granted_at = UTC_TIMESTAMP(),
            revoked_at = NULL, revoked_by = NULL, active = 1
      WHERE id = ?`,
    [params.appId, params.assignmentType, targetId, updatedBy, assignmentId],
  );

  await logAppAccessAudit({
    appId: params.appId,
    action: params.assignmentType === 'USER' ? 'ASSIGN_USER' : 'ASSIGN_GROUP',
    actorEmpId: updatedBy,
    targetEmpId: params.assignmentType === 'USER' ? targetId : null,
    tagGroupId: params.assignmentType === 'TAG_GROUP' ? targetId : null,
    details: {
      source: 'ADMIN',
      assignmentId,
      assignmentType: params.assignmentType,
      groupId: params.assignmentType === 'GROUP' ? targetId : undefined,
      previous: {
        appId: row.app_id,
        assignmentType: row.assignment_type,
        targetId: row.target_id,
      },
    },
  });
}

export async function revokeAllUserAppAccess(params: {
  empId: string;
  revokedBy: string;
  source?: string;
  reason?: string;
  /** When set, only revoke assignments for apps with an active SAML SP (e.g. Slack). */
  samlOnly?: boolean;
}): Promise<{ revoked: number; appIds: string[] }> {
  const where: string[] = [
    'aaa.active = 1',
    "aaa.assignment_type = 'USER'",
    'aaa.target_id = ?',
  ];
  const queryParams: unknown[] = [params.empId];

  if (params.samlOnly) {
    where.push(
      `EXISTS (
         SELECT 1 FROM applications a
         INNER JOIN saml_service_providers sp ON sp.slug = a.slug AND sp.active = 1
         WHERE a.id = aaa.app_id
       )`,
    );
  }

  const rows = await query<{ id: string; app_id: string; app_slug: string | null }>(
    `SELECT aaa.id, aaa.app_id, a.slug AS app_slug
       FROM app_access_assignments aaa
       LEFT JOIN applications a ON a.id = aaa.app_id
      WHERE ${where.join(' AND ')}`,
    queryParams,
  );

  const appIds: string[] = [];
  for (const row of rows) {
    const revokeOpts: { source?: string; reason?: string } = {
      source: params.source ?? 'LIFECYCLE',
    };
    if (params.reason) revokeOpts.reason = params.reason;
    await revokeAppAccess(row.id, params.revokedBy, revokeOpts);
    appIds.push(row.app_id);
  }

  if (rows.length > 0) {
    logger.info(
      {
        empId: params.empId,
        revoked: rows.length,
        samlOnly: params.samlOnly ?? false,
        source: params.source,
        apps: rows.map((r) => r.app_slug || r.app_id),
      },
      'Revoked application access assignments for disabled user',
    );
  }

  return { revoked: rows.length, appIds };
}

export async function revokeAppAccess(
  assignmentId: string,
  revokedBy: string,
  opts?: { source?: string; reason?: string },
): Promise<void> {
  const row = await queryOne<{
    app_id: string;
    assignment_type: AssignmentType;
    target_id: string;
  }>(
    `SELECT app_id, assignment_type, target_id FROM app_access_assignments WHERE id = ?`,
    [assignmentId],
  );
  if (!row) throw new Error('Assignment not found');

  await execute(
    `UPDATE app_access_assignments
        SET active = 0, revoked_at = UTC_TIMESTAMP(), revoked_by = ?
      WHERE id = ?`,
    [revokedBy, assignmentId],
  );

  await logAppAccessAudit({
    appId: row.app_id,
    action: 'REVOKE',
    actorEmpId: revokedBy,
    targetEmpId: row.assignment_type === 'USER' ? row.target_id : null,
    tagGroupId: row.assignment_type === 'TAG_GROUP' ? row.target_id : null,
    details: {
      assignmentId,
      assignmentType: row.assignment_type,
      groupId: row.assignment_type === 'GROUP' ? row.target_id : undefined,
      ...(opts?.source ? { source: opts.source } : {}),
      ...(opts?.reason ? { reason: opts.reason } : {}),
    },
  });

  if (row.assignment_type === 'USER') {
    void deprovisionAppUser({
      appId: row.app_id,
      empId: row.target_id,
      actorEmpId: revokedBy,
      source: opts?.source ?? 'ADMIN',
    }).catch((err) => logger.warn({ err, appId: row.app_id, empId: row.target_id }, 'App deprovision failed'));
  }
}

// ---------------------------------------------------------------------------
// Workflow resolution for access requests
// ---------------------------------------------------------------------------
export async function resolveWorkflowForRequest(
  appId: string,
  tagGroupId?: string | null,
): Promise<WorkflowRow | null> {
  if (tagGroupId) {
    const specific = await queryOne<WorkflowRow>(
      `SELECT id, app_id, tag_group_id, name, approval_levels, requester_group_ids,
              auto_provision, active
         FROM app_group_access_workflows
        WHERE app_id = ? AND tag_group_id = ? AND active = 1
        ORDER BY updated_at DESC LIMIT 1`,
      [appId, tagGroupId],
    );
    if (specific) return specific;
  }

  return queryOne<WorkflowRow>(
    `SELECT id, app_id, tag_group_id, name, approval_levels, requester_group_ids,
            auto_provision, active
       FROM app_group_access_workflows
      WHERE app_id = ? AND tag_group_id IS NULL AND active = 1
      ORDER BY updated_at DESC LIMIT 1`,
    [appId],
  );
}

export function parseRequesterGroupIds(raw: unknown): string[] {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((v) => String(v ?? '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function userInAnyIdentityGroup(empId: string, groupIds: string[]): Promise<boolean> {
  if (!groupIds.length) return true;
  const placeholders = groupIds.map(() => '?').join(', ');
  const membership = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM group_members
      WHERE emp_id COLLATE utf8mb4_unicode_ci = ? COLLATE utf8mb4_unicode_ci
        AND group_id COLLATE utf8mb4_unicode_ci IN (${placeholders})`,
    [empId, ...groupIds],
  );
  return Number(membership?.n ?? 0) > 0;
}

export type JitEligibility = {
  ok: boolean;
  reason?: string;
  reasonCode?: 'INACTIVE' | 'JIT_OFF' | 'ASSIGNED' | 'PENDING' | 'NO_WORKFLOW' | 'GROUP_DENIED';
  pending?: PendingAppAccessInfo;
};

/** True when requester may submit a JIT request for this app under active workflows. */
export async function canUserRequestApp(
  empId: string,
  appId: string,
): Promise<JitEligibility> {
  const app = await queryOne<{ id: string; slug: string; requestable: number; active: number }>(
    `SELECT id, slug, requestable, active FROM applications WHERE id = ? LIMIT 1`,
    [appId],
  );
  if (!app || Number(app.active) !== 1) {
    return { ok: false, reasonCode: 'INACTIVE', reason: 'Application not found or inactive' };
  }
  if (Number(app.requestable) !== 1) {
    return {
      ok: false,
      reasonCode: 'JIT_OFF',
      reason: 'Application is not enabled for Request Access (JIT) — turn on “Show in Request Access” on the workflow',
    };
  }

  // Assigned users launch from All Applications — never need Request Access again
  if (await hasPolicyAppAccess(empId, app.slug)) {
    return {
      ok: false,
      reasonCode: 'ASSIGNED',
      reason: 'You already have access — open it from All Applications (no request needed)',
    };
  }

  const pending = await getActivePendingAppAccessRequest(empId, appId);
  if (pending) {
    return {
      ok: false,
      reasonCode: 'PENDING',
      reason: 'Awaiting approval — you can request again after the approval window expires',
      pending,
    };
  }

  const workflows = await query<WorkflowRow>(
    `SELECT id, app_id, tag_group_id, name, approval_levels, requester_group_ids,
            auto_provision, active
       FROM app_group_access_workflows
      WHERE app_id = ? AND active = 1`,
    [appId],
  );
  if (!workflows.length) {
    return {
      ok: false,
      reasonCode: 'NO_WORKFLOW',
      reason: 'No active access request workflow configured for this application',
    };
  }

  // Eligible if any active workflow allows this user (empty requester groups = open).
  let restrictedWorkflows = 0;
  for (const wf of workflows) {
    const groupIds = parseRequesterGroupIds(wf.requester_group_ids);
    if (groupIds.length === 0) return { ok: true };
    restrictedWorkflows += 1;
    if (await userInAnyIdentityGroup(empId, groupIds)) return { ok: true };
  }

  if (restrictedWorkflows > 0) {
    return {
      ok: false,
      reasonCode: 'GROUP_DENIED',
      reason: 'You are not in the identity groups allowed to request this app (check “Who can request” on the JIT workflow, or leave groups unchecked for any user)',
    };
  }

  return {
    ok: false,
    reasonCode: 'GROUP_DENIED',
    reason: 'Your groups are not permitted to request this application',
  };
}

export type JitAppRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  icon_url: string | null;
  category: string | null;
};

/**
 * JIT Request Access catalog for the signed-in user:
 * requestable apps with an active workflow that the user does **not** already hold
 * (assignment = launch from All Applications, no request), with no pending request,
 * and that their identity groups are allowed to request.
 */
export async function listJitRequestableAppsForUser(empId: string): Promise<JitAppRow[]> {
  await expireStaleAccessRequests(empId);
  // Keep SQL simple — pending/group checks run in canUserRequestApp (avoids JSON_CONTAINS failures silencing the catalog).
  const rows = await query<JitAppRow>(
    `SELECT a.id, a.slug, a.name, a.description, a.icon_url, a.category
       FROM applications a
      WHERE a.active = 1
        AND a.requestable = 1
        AND EXISTS (
          SELECT 1 FROM app_group_access_workflows w
           WHERE w.app_id = a.id AND w.active = 1
        )
      ORDER BY a.name`,
    [],
  );

  const out: JitAppRow[] = [];
  for (const app of rows) {
    const check = await canUserRequestApp(empId, app.id);
    if (check.ok) out.push(app);
  }
  return out;
}

export type JitHiddenApp = {
  id: string;
  slug: string;
  name: string;
  icon_url?: string | null;
  reason: string;
  reasonCode?: JitEligibility['reasonCode'];
  slaDueAt?: string | null;
  requestId?: string | null;
};

/**
 * Explain why JIT apps are or are not visible to this user (for empty-catalog UX / support).
 * Includes apps with a workflow even when requestable=0 so admins can see misconfiguration.
 * Stale PENDING requests past sla_due_at are expired first so those apps become requestable again.
 */
export async function explainJitCatalogForUser(empId: string): Promise<{
  available: JitAppRow[];
  hidden: JitHiddenApp[];
}> {
  await expireStaleAccessRequests(empId);
  const rows = await query<JitAppRow & { requestable: number }>(
    `SELECT a.id, a.slug, a.name, a.description, a.icon_url, a.category, a.requestable
       FROM applications a
      WHERE a.active = 1
        AND EXISTS (
          SELECT 1 FROM app_group_access_workflows w
           WHERE w.app_id = a.id AND w.active = 1
        )
      ORDER BY a.name`,
    [],
  );

  const available: JitAppRow[] = [];
  const hidden: JitHiddenApp[] = [];
  for (const app of rows) {
    const check = await canUserRequestApp(empId, app.id);
    if (check.ok) {
      available.push({
        id: app.id,
        slug: app.slug,
        name: app.name,
        description: app.description,
        icon_url: app.icon_url,
        category: app.category,
      });
    } else {
      hidden.push({
        id: app.id,
        slug: app.slug,
        name: app.name,
        icon_url: app.icon_url,
        reason: check.reason || 'Not eligible',
        reasonCode: check.reasonCode,
        slaDueAt: check.pending?.slaDueAt ?? null,
        requestId: check.pending?.requestId ?? null,
      });
    }
  }
  return { available, hidden };
}

export async function setApplicationRequestable(
  appId: string,
  requestable: boolean,
): Promise<void> {
  await execute(
    `UPDATE applications SET requestable = ? WHERE id = ?`,
    [requestable ? 1 : 0, appId],
  );
}

/**
 * Enable IGA Request Access (JIT) for a SAML-connected application:
 * mirror into applications, create a default approval workflow if missing,
 * mark requestable. Empty requester groups = any authenticated user may request.
 */
export async function enableSamlAppRequestAccess(
  slug: string,
  createdBy: string,
): Promise<{ appId: string; workflowId: string | null; created: boolean }> {
  await ensureSamlAppMirrored(slug);
  const app = await queryOne<{ id: string; name: string; requestable: number }>(
    `SELECT id, name, requestable FROM applications WHERE slug = ? LIMIT 1`,
    [slug],
  );
  if (!app) {
    throw new Error(`Application not found for SAML slug ${slug}`);
  }

  const existingWf = await queryOne<{ id: string }>(
    `SELECT id FROM app_group_access_workflows
      WHERE app_id = ? AND active = 1 LIMIT 1`,
    [app.id],
  );

  let workflowId: string | null = existingWf?.id ?? null;
  let created = false;

  if (!workflowId) {
    workflowId = uuidv4();
    const levels: ApprovalLevel[] = [
      { level: 1, approverType: 'MANAGER' },
      { level: 2, approverType: 'ADMIN' },
    ];
    await execute(
      `INSERT INTO app_group_access_workflows
         (id, app_id, tag_group_id, name, approval_levels, requester_group_ids, auto_provision, created_by)
       VALUES (?, ?, NULL, ?, ?, ?, 1, ?)`,
      [
        workflowId,
        app.id,
        `${app.name} SSO access`,
        JSON.stringify(levels),
        JSON.stringify([]),
        createdBy,
      ],
    );
    created = true;
    logger.info({ slug, appId: app.id, workflowId }, 'Created default JIT workflow for SAML app');
  }

  await setApplicationRequestable(app.id, true);
  return { appId: app.id, workflowId, created };
}

/** Enable Request Access for every active SAML SP that is mirrored. */
export async function enableRequestAccessForAllSamlApps(
  createdBy: string,
): Promise<{ enabled: number; createdWorkflows: number; errors: string[] }> {
  const sps = await query<{ slug: string }>(
    `SELECT slug FROM saml_service_providers WHERE active = 1 ORDER BY name`,
    [],
  );
  let enabled = 0;
  let createdWorkflows = 0;
  const errors: string[] = [];
  for (const sp of sps) {
    try {
      const r = await enableSamlAppRequestAccess(sp.slug, createdBy);
      enabled += 1;
      if (r.created) createdWorkflows += 1;
    } catch (err) {
      errors.push(`${sp.slug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { enabled, createdWorkflows, errors };
}

export function parseApprovalLevels(raw: string | unknown): ApprovalLevel[] {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? (parsed as ApprovalLevel[]) : [];
  } catch {
    return [];
  }
}

export async function resolveApproversFromWorkflow(
  levels: ApprovalLevel[],
  targetEmpId: string,
  appId: string,
): Promise<{ level: number; empId: string }[]> {
  const approvers: { level: number; empId: string }[] = [];
  const seen = new Set<string>();

  for (const lvl of levels.sort((a, b) => a.level - b.level)) {
    let empId: string | null = null;

    switch (lvl.approverType) {
      case 'MANAGER': {
        const mgr = await queryOne<{ manager_emp_id: string | null }>(
          `SELECT manager_emp_id FROM employees WHERE emp_id = ?`,
          [targetEmpId],
        ).catch(() => null);
        empId = mgr?.manager_emp_id ?? null;
        break;
      }
      case 'APP_OWNER': {
        const owner = await queryOne<{ owner_emp_id: string | null }>(
          `SELECT owner_emp_id FROM applications WHERE id = ?`,
          [appId],
        );
        empId = owner?.owner_emp_id ?? null;
        break;
      }
      case 'SPECIFIC':
        empId = lvl.approverEmpId ?? null;
        break;
      case 'ADMIN': {
        const admin = await queryOne<{ emp_id: string }>(
          `SELECT emp_id FROM employees
            WHERE role IN ('ADMIN','SUPER_ADMIN') AND ilg_state = 'ACTIVE'
            ORDER BY role = 'SUPER_ADMIN' DESC LIMIT 1`,
          [],
        );
        empId = admin?.emp_id ?? null;
        break;
      }
    }

    if (empId && !seen.has(empId)) {
      seen.add(empId);
      approvers.push({ level: lvl.level, empId });
    }
  }

  return approvers;
}

// ---------------------------------------------------------------------------
// Fulfillment after approved APP_ACCESS request
// itemIds: [appId] or [appId, tagGroupId]
// ---------------------------------------------------------------------------
export async function fulfillAppAccessRequest(params: {
  targetEmpId: string;
  itemIds: string[];
  grantedBy: string;
  requestId: string;
  autoProvision?: boolean;
}): Promise<void> {
  const appId = params.itemIds[0];
  if (!appId) return;

  const tagGroupId = params.itemIds[1] ?? null;

  if (params.autoProvision !== false) {
    if (tagGroupId) {
      await execute(
        `INSERT IGNORE INTO tag_group_members (tag_group_id, emp_id, added_by) VALUES (?, ?, ?)`,
        [tagGroupId, params.targetEmpId, params.grantedBy],
      );
    } else {
      await grantAppAccess({
        appId,
        assignmentType: 'USER',
        targetId: params.targetEmpId,
        grantedBy: params.grantedBy,
        source: 'REQUEST',
        requestId: params.requestId,
      });
    }

    await logAppAccessAudit({
      appId,
      action: 'PROVISION',
      actorEmpId: params.grantedBy,
      targetEmpId: params.targetEmpId,
      tagGroupId,
      requestId: params.requestId,
    });
  }
}
