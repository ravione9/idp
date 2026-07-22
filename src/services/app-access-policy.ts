/**
 * Application Access Policy — user/tag-group assignments, workflow config, audit.
 */

import { v4 as uuidv4 } from 'uuid';
import { query, queryOne, execute } from '../db/connection.js';
import logger from '../utils/logger.js';
import { canReceiveSamlAssertion, evaluateEntitlement } from '../saml/entitlements.js';
import type { EmployeeSamlContext, EntitlementRule } from '../saml/types.js';

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
  return query(
    `SELECT a.id, a.slug, a.name, a.icon_url, a.category, a.active,
            EXISTS (
              SELECT 1 FROM saml_service_providers sp WHERE sp.slug = a.slug AND sp.active = 1
            ) AS has_saml
       FROM applications a
      WHERE a.active = 1
      ORDER BY a.sort_order ASC, a.name ASC`,
    [],
  );
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

export async function canUserLaunchApp(
  emp: EmployeeSamlContext,
  slug: string,
  rule: EntitlementRule | null,
): Promise<boolean> {
  if (!canReceiveSamlAssertion(emp)) return false;

  try {
    const requiresGrant = await appRequiresExplicitGrant(slug);
    const policyAccess = await hasPolicyAppAccess(emp.emp_id, slug);
    if (requiresGrant) {
      if (!policyAccess) {
        logger.info(
          { empId: emp.emp_id, slug },
          'SSO denied — no Application Access Policy grant',
        );
      }
      return policyAccess;
    }
    // Non-SAML catalog apps only: optional birthright via entitlement_rule.
    return policyAccess || evaluateEntitlement(emp, rule);
  } catch (err) {
    // Fail closed — never fall back to open entitlement on policy errors.
    logger.warn({ err, empId: emp.emp_id, slug }, 'App access policy check failed; denying launch');
    return false;
  }
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
        )
      LIMIT 1`,
    [appSlug, empId, empId, empId],
  );
  return (row?.ok ?? 0) === 1;
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
async function assertAssignmentTarget(
  assignmentType: AssignmentType,
  targetId: string,
): Promise<void> {
  if (assignmentType === 'USER') {
    const emp = await queryOne<{ emp_id: string }>(
      `SELECT emp_id FROM employees WHERE emp_id = ? AND ilg_state IN ('ACTIVE','REACTIVATED') LIMIT 1`,
      [targetId],
    );
    if (!emp) throw new Error('Employee not found or not active');
    return;
  }
  if (assignmentType === 'GROUP') {
    const grp = await queryOne<{ id: string }>(
      `SELECT id FROM \`groups\` WHERE id = ? AND active = 1 LIMIT 1`,
      [targetId],
    );
    if (!grp) throw new Error('Identity group not found or inactive');
    return;
  }
  const tg = await queryOne<{ id: string }>(
    `SELECT id FROM tag_groups WHERE id = ? AND active = 1 LIMIT 1`,
    [targetId],
  );
  if (!tg) throw new Error('Tag group not found or inactive');
}

export async function grantAppAccess(params: {
  appId: string;
  assignmentType: AssignmentType;
  targetId: string;
  grantedBy: string;
  source?: 'ADMIN' | 'REQUEST';
  requestId?: string;
}): Promise<string> {
  await assertAssignmentTarget(params.assignmentType, params.targetId);

  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM app_access_assignments
      WHERE app_id = ? AND assignment_type = ? AND target_id = ?`,
    [params.appId, params.assignmentType, params.targetId],
  );

  if (existing) {
    await execute(
      `UPDATE app_access_assignments
          SET active = 1, granted_by = ?, granted_at = UTC_TIMESTAMP(),
              revoked_at = NULL, revoked_by = NULL
        WHERE id = ?`,
      [params.grantedBy, existing.id],
    );
    await logAppAccessAudit({
      appId: params.appId,
      action: params.assignmentType === 'USER' ? 'ASSIGN_USER' : 'ASSIGN_GROUP',
      actorEmpId: params.grantedBy,
      targetEmpId: params.assignmentType === 'USER' ? params.targetId : null,
      tagGroupId: params.assignmentType === 'TAG_GROUP' ? params.targetId : null,
      requestId: params.requestId ?? null,
      details: {
        source: params.source ?? 'ADMIN',
        assignmentId: existing.id,
        assignmentType: params.assignmentType,
        groupId: params.assignmentType === 'GROUP' ? params.targetId : undefined,
      },
    });
    return existing.id;
  }

  const id = uuidv4();
  await execute(
    `INSERT INTO app_access_assignments
       (id, app_id, assignment_type, target_id, active, granted_by, granted_at)
     VALUES (?, ?, ?, ?, 1, ?, UTC_TIMESTAMP())`,
    [id, params.appId, params.assignmentType, params.targetId, params.grantedBy],
  );

  await logAppAccessAudit({
    appId: params.appId,
    action: params.assignmentType === 'USER' ? 'ASSIGN_USER' : 'ASSIGN_GROUP',
    actorEmpId: params.grantedBy,
    targetEmpId: params.assignmentType === 'USER' ? params.targetId : null,
    tagGroupId: params.assignmentType === 'TAG_GROUP' ? params.targetId : null,
    requestId: params.requestId ?? null,
    details: {
      source: params.source ?? 'ADMIN',
      assignmentId: id,
      assignmentType: params.assignmentType,
      groupId: params.assignmentType === 'GROUP' ? params.targetId : undefined,
    },
  });

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

  await assertAssignmentTarget(params.assignmentType, params.targetId);

  const conflict = await queryOne<{ id: string }>(
    `SELECT id FROM app_access_assignments
      WHERE app_id = ? AND assignment_type = ? AND target_id = ? AND id <> ?`,
    [params.appId, params.assignmentType, params.targetId, assignmentId],
  );
  if (conflict) {
    throw new Error('An assignment for this application and target already exists');
  }

  const unchanged =
    row.app_id === params.appId &&
    row.assignment_type === params.assignmentType &&
    row.target_id === params.targetId;
  if (unchanged) return;

  await execute(
    `UPDATE app_access_assignments
        SET app_id = ?, assignment_type = ?, target_id = ?,
            granted_by = ?, granted_at = UTC_TIMESTAMP(),
            revoked_at = NULL, revoked_by = NULL, active = 1
      WHERE id = ?`,
    [params.appId, params.assignmentType, params.targetId, params.updatedBy, assignmentId],
  );

  await logAppAccessAudit({
    appId: params.appId,
    action: params.assignmentType === 'USER' ? 'ASSIGN_USER' : 'ASSIGN_GROUP',
    actorEmpId: params.updatedBy,
    targetEmpId: params.assignmentType === 'USER' ? params.targetId : null,
    tagGroupId: params.assignmentType === 'TAG_GROUP' ? params.targetId : null,
    details: {
      source: 'ADMIN',
      assignmentId,
      assignmentType: params.assignmentType,
      groupId: params.assignmentType === 'GROUP' ? params.targetId : undefined,
      previous: {
        appId: row.app_id,
        assignmentType: row.assignment_type,
        targetId: row.target_id,
      },
    },
  });
}

export async function revokeAppAccess(
  assignmentId: string,
  revokedBy: string,
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
    },
  });
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

/** True when requester may submit a JIT request for this app under active workflows. */
export async function canUserRequestApp(
  empId: string,
  appId: string,
): Promise<{ ok: boolean; reason?: string }> {
  const app = await queryOne<{ id: string; slug: string; requestable: number; active: number }>(
    `SELECT id, slug, requestable, active FROM applications WHERE id = ? LIMIT 1`,
    [appId],
  );
  if (!app || !app.active) {
    return { ok: false, reason: 'Application not found or inactive' };
  }
  if (!app.requestable) {
    return { ok: false, reason: 'Application is not enabled for Request Access (JIT)' };
  }

  if (await hasPolicyAppAccess(empId, app.slug)) {
    return { ok: false, reason: 'You already have access to this application' };
  }

  const workflows = await query<WorkflowRow>(
    `SELECT id, app_id, tag_group_id, name, approval_levels, requester_group_ids,
            auto_provision, active
       FROM app_group_access_workflows
      WHERE app_id = ? AND active = 1`,
    [appId],
  );
  if (!workflows.length) {
    return { ok: false, reason: 'No active access request workflow configured for this application' };
  }

  // Eligible if any active workflow allows this user (empty requester groups = open).
  for (const wf of workflows) {
    const groupIds = parseRequesterGroupIds(wf.requester_group_ids);
    if (groupIds.length === 0) return { ok: true };
    const placeholders = groupIds.map(() => '?').join(', ');
    const membership = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM group_members
        WHERE emp_id = ? AND group_id IN (${placeholders})`,
      [empId, ...groupIds],
    );
    if ((membership?.n ?? 0) > 0) return { ok: true };
  }

  return { ok: false, reason: 'Your groups are not permitted to request this application' };
}

/**
 * JIT Request Access catalog for the signed-in user:
 * requestable apps with an active workflow, that the user does not already hold,
 * and that their identity groups are allowed to request.
 */
export async function listJitRequestableAppsForUser(empId: string): Promise<{
  id: string;
  slug: string;
  name: string;
  description: string | null;
  icon_url: string | null;
  category: string | null;
}[]> {
  const rows = await query<{
    id: string;
    slug: string;
    name: string;
    description: string | null;
    icon_url: string | null;
    category: string | null;
  }>(
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

  const out: typeof rows = [];
  for (const app of rows) {
    const check = await canUserRequestApp(empId, app.id);
    if (check.ok) out.push(app);
  }
  return out;
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
