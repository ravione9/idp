/**
 * Access Request Workflow
 * -----------------------
 * Handles the full lifecycle of access requests:
 * - Submit: SoD pre-check → insert request + approvals → notify approvers
 * - Decision: approve/reject → fulfill if all approved → notify requester
 */

import { query, queryOne, execute } from '../db/connection.js';
import { v4 as uuidv4 } from 'uuid';
import { evaluateSodForGrant } from './sod-evaluator.js';
import { sendNotification } from './notification.js';
import {
  resolveWorkflowForRequest,
  parseApprovalLevels,
  resolveApproversFromWorkflow,
  fulfillAppAccessRequest,
  logAppAccessAudit,
  canUserRequestApp,
  expireStaleAccessRequests,
} from './app-access-policy.js';
import { emitPlatformEvent } from './event-dispatcher.js';
import logger from '../utils/logger.js';

const PENDING_STATUS = 'PENDING';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface AccessRequestParams {
  requesterEmpId: string;
  targetEmpId: string;
  itemType: 'ENTITLEMENT' | 'ROLE' | 'APP_ACCESS';
  itemIds: string[];
  justification: string;
}

interface RequestRow {
  id: string;
  requester_emp_id: string;
  target_emp_id: string;
  item_type: string;
  item_ids: string;
  status: string;
}

interface ApprovalRow {
  id: string;
  request_id: string;
  level: number;
  approver_emp_id: string;
  decision: string;
}

// ---------------------------------------------------------------------------
// submitAccessRequest
// ---------------------------------------------------------------------------
export async function submitAccessRequest(params: AccessRequestParams): Promise<string> {
  // Validate target employee exists and is ACTIVE
  const target = await queryOne<{ emp_id: string; ilg_state: string }>(
    'SELECT emp_id, ilg_state FROM employees WHERE emp_id = ?',
    [params.targetEmpId],
  );

  if (!target) {
    throw new Error('Target employee not found');
  }
  if (target.ilg_state !== 'ACTIVE') {
    throw new Error(`Target employee is not active (state: ${target.ilg_state})`);
  }

  // JIT / Request Access eligibility for applications
  if (params.itemType === 'APP_ACCESS' && params.itemIds.length > 0) {
    const appId = params.itemIds[0]!;
    // Expire SLA-elapsed PENDING requests so the user can request again
    await expireStaleAccessRequests(params.targetEmpId, appId);
    await expireStaleAccessRequests(params.requesterEmpId, appId);
    const eligibility = await canUserRequestApp(params.requesterEmpId, appId);
    if (!eligibility.ok) {
      throw new Error(eligibility.reason || 'You are not eligible to request this application');
    }
    // When requesting for someone else, also ensure target does not already have access
    if (params.targetEmpId !== params.requesterEmpId) {
      const targetElig = await canUserRequestApp(params.targetEmpId, appId);
      if (targetElig.reasonCode === 'ASSIGNED') {
        throw new Error('Target employee already has access to this application');
      }
      if (targetElig.reasonCode === 'PENDING') {
        throw new Error('Target employee already has a pending request for this application');
      }
    }
  }

  // SoD pre-check for ENTITLEMENT type
  if (params.itemType === 'ENTITLEMENT') {
    const blockingViolations: string[] = [];

    for (const itemId of params.itemIds) {
      const sodResult = await evaluateSodForGrant(params.targetEmpId, itemId);
      const blocking = sodResult.violations.filter((v) => {
        // We need to check the enforcement field for this policy
        return v.severity === 'CRITICAL' || v.severity === 'HIGH';
      });
      if (blocking.length > 0) {
        blockingViolations.push(
          ...blocking.map((v) => `Policy "${v.policyName}" (${v.severity}): conflicts with [${v.conflictingEntitlements.join(', ')}]`),
        );
      }
    }

    if (blockingViolations.length > 0) {
      throw new Error(`SoD violations prevent this grant: ${blockingViolations.join('; ')}`);
    }
  }

  const reqId = uuidv4();
  const slaDue = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

  await execute(
    `INSERT INTO access_requests
       (id, requester_emp_id, target_emp_id, item_type, item_ids, justification,
        status, created_at, sla_due_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), ?)`,
    [
      reqId,
      params.requesterEmpId,
      params.targetEmpId,
      params.itemType,
      JSON.stringify(params.itemIds),
      params.justification,
      PENDING_STATUS,
      slaDue.toISOString().slice(0, 19).replace('T', ' '),
    ],
  );

  // Determine approvers
  let approvers: { level: number; empId: string }[] = [];

  if (params.itemType === 'APP_ACCESS' && params.itemIds.length > 0) {
    const appId = params.itemIds[0]!;
    const tagGroupId = params.itemIds[1] ?? null;
    const workflow = await resolveWorkflowForRequest(appId, tagGroupId);
    if (workflow) {
      const levels = parseApprovalLevels(workflow.approval_levels);
      approvers = await resolveApproversFromWorkflow(levels, params.targetEmpId, appId);
    }
    await logAppAccessAudit({
      appId,
      action: 'REQUEST',
      actorEmpId: params.requesterEmpId,
      targetEmpId: params.targetEmpId,
      tagGroupId,
      requestId: reqId,
      details: { itemIds: params.itemIds, workflowId: workflow?.id ?? null },
    });
  }

  if (approvers.length === 0) {
    // Level 1: manager of target employee (if available)
    const managerRow = await queryOne<{ manager_emp_id: string | null }>(
      `SELECT manager_emp_id FROM employees WHERE emp_id = ?`,
      [params.targetEmpId],
    ).catch(() => null);

    if (managerRow?.manager_emp_id) {
      approvers.push({ level: 1, empId: managerRow.manager_emp_id });
    }

    // Level 2: app owner for entitlements / app access, or any ADMIN
    let level2Approver: string | null = null;

    if (
      (params.itemType === 'ENTITLEMENT' || params.itemType === 'APP_ACCESS')
      && params.itemIds.length > 0
    ) {
      if (params.itemType === 'ENTITLEMENT') {
        const appOwner = await queryOne<{ owner_emp_id: string | null }>(
          `SELECT a.owner_emp_id
             FROM entitlements e
             JOIN applications a ON a.id = e.app_id
            WHERE e.id = ? AND a.owner_emp_id IS NOT NULL`,
          [params.itemIds[0]],
        ).catch(() => null);
        level2Approver = appOwner?.owner_emp_id ?? null;
      } else {
        const appOwner = await queryOne<{ owner_emp_id: string | null }>(
          `SELECT owner_emp_id FROM applications WHERE id = ? AND owner_emp_id IS NOT NULL`,
          [params.itemIds[0]],
        ).catch(() => null);
        level2Approver = appOwner?.owner_emp_id ?? null;
      }
    }

    if (!level2Approver) {
      const admin = await queryOne<{ emp_id: string }>(
        `SELECT emp_id FROM employees WHERE role = 'ADMIN' AND ilg_state = 'ACTIVE' LIMIT 1`,
        [],
      ).catch(() => null);
      if (admin) {
        level2Approver = admin.emp_id;
      }
    }

    if (level2Approver) {
      const alreadyAdded = approvers.some((a) => a.empId === level2Approver);
      if (!alreadyAdded) {
        approvers.push({ level: approvers.length + 1, empId: level2Approver });
      }
    }
  }

  // If no approvers found, self-approve via SUPER_ADMIN
  if (approvers.length === 0) {
    const superAdmin = await queryOne<{ emp_id: string }>(
      `SELECT emp_id FROM employees WHERE role = 'SUPER_ADMIN' AND ilg_state = 'ACTIVE' LIMIT 1`,
      [],
    );
    if (superAdmin) {
      approvers.push({ level: 1, empId: superAdmin.emp_id });
    }
  }

  // Insert approval rows
  for (const approver of approvers) {
    await execute(
      `INSERT INTO access_request_approvals
         (id, request_id, level, approver_emp_id, decision)
       VALUES (?, ?, ?, ?, 'PENDING')`,
      [uuidv4(), reqId, approver.level, approver.empId],
    );

    // Notify approver
    await sendNotification({
      recipientEmpId: approver.empId,
      channel:        'IN_APP',
      subject:        'Access Request Pending Your Approval',
      body:           `An access request (${reqId}) from ${params.requesterEmpId} for ${params.targetEmpId} requires your approval.`,
      referenceId:    reqId,
      referenceType:  'ACCESS_REQUEST',
    }).catch((err) => logger.warn({ err, reqId }, 'Failed to notify approver'));
  }

  logger.info({ reqId, requester: params.requesterEmpId, target: params.targetEmpId }, 'Access request submitted');

  emitPlatformEvent('ACCESS_REQUEST', {
    empId: params.targetEmpId,
    initiatedBy: params.requesterEmpId,
    context: {
      requestId: reqId,
      itemType: params.itemType,
      itemIds: params.itemIds,
      justification: params.justification,
    },
  });

  return reqId;
}

// ---------------------------------------------------------------------------
// processDecision
// ---------------------------------------------------------------------------
export async function processDecision(
  requestId: string,
  actorEmpId: string,
  decision: 'APPROVE' | 'REJECT',
  comment?: string,
  opts?: { adminOverride?: boolean },
): Promise<void> {
  // Fetch request
  const request = await queryOne<RequestRow>(
    `SELECT id, requester_emp_id, target_emp_id, item_type, item_ids, status
       FROM access_requests
      WHERE id = ?`,
    [requestId],
  );

  if (!request) {
    throw new Error('Access request not found');
  }
  // Wipe SLA-elapsed requests before allowing a decision
  await expireStaleAccessRequests(request.target_emp_id);
  const live = await queryOne<RequestRow>(
    `SELECT id, requester_emp_id, target_emp_id, item_type, item_ids, status
       FROM access_requests WHERE id = ?`,
    [requestId],
  );
  if (!live || live.status !== PENDING_STATUS) {
    throw new Error(
      `Request is not in PENDING state (current: ${live?.status ?? request.status}) — expired approvals are auto-wiped`,
    );
  }
  // Prefer post-expiry row for the rest of the handler
  Object.assign(request, live);

  const adminOverride = opts?.adminOverride === true;
  const decisionDb = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';

  // Normal path: actor must be a pending approver on this request
  const approval = await queryOne<ApprovalRow>(
    `SELECT id, request_id, level, approver_emp_id, decision
       FROM access_request_approvals
      WHERE request_id = ? AND approver_emp_id = ? AND decision = 'PENDING'`,
    [requestId, actorEmpId],
  );

  if (!approval && !adminOverride) {
    throw new Error('No pending approval found for this approver on this request');
  }

  if (adminOverride && !approval) {
    const pendingRows = await query<{ id: number; level: number }>(
      `SELECT id, level FROM access_request_approvals
        WHERE request_id = ? AND decision = 'PENDING'`,
      [requestId],
    );
    if (!pendingRows.length) {
      throw new Error('No pending approval found for this request');
    }
    const overrideComment = `[Admin override by ${actorEmpId}]${comment ? ` ${comment}` : ''}`;
    for (const row of pendingRows) {
      await execute(
        `UPDATE access_request_approvals
            SET decision = ?, comment = ?, decided_at = UTC_TIMESTAMP()
          WHERE id = ?`,
        [decisionDb, overrideComment, row.id],
      );
    }
    logger.info(
      { requestId, actorEmpId, decision, pendingLevels: pendingRows.length },
      'Access request decided via admin override',
    );
  } else if (approval) {
    const note = adminOverride
      ? `[Admin override by ${actorEmpId}]${comment ? ` ${comment}` : ''}`
      : (comment ?? null);
    await execute(
      `UPDATE access_request_approvals
          SET decision = ?, comment = ?, decided_at = UTC_TIMESTAMP()
        WHERE id = ?`,
      [decisionDb, note, approval.id],
    );

    // Admin override while also being an approver: clear remaining pending levels
    if (adminOverride) {
      await execute(
        `UPDATE access_request_approvals
            SET decision = ?,
                comment = COALESCE(comment, ?),
                decided_at = UTC_TIMESTAMP()
          WHERE request_id = ? AND decision = 'PENDING'`,
        [decisionDb, `[Admin override by ${actorEmpId}]`, requestId],
      );
    }
  }

  if (request.item_type === 'APP_ACCESS') {
    let itemIds: string[] = [];
    try { itemIds = JSON.parse(request.item_ids) as string[]; } catch { /* empty */ }
    await logAppAccessAudit({
      appId: itemIds[0] ?? null,
      action: decision === 'REJECT' ? 'REJECT' : 'APPROVE',
      actorEmpId,
      targetEmpId: request.target_emp_id,
      tagGroupId: itemIds[1] ?? null,
      requestId,
      details: {
        comment: comment ?? null,
        level: approval?.level ?? null,
        adminOverride,
      },
    });
  }

  if (decision === 'REJECT') {
    await execute(
      `UPDATE access_requests SET status = 'REJECTED', decided_at = UTC_TIMESTAMP() WHERE id = ?`,
      [requestId],
    );

    await sendNotification({
      recipientEmpId: request.requester_emp_id,
      channel:        'IN_APP',
      subject:        'Access Request Rejected',
      body:           `Your access request (${requestId}) has been rejected. ${comment ? `Reason: ${comment}` : ''}`,
      referenceId:    requestId,
      referenceType:  'ACCESS_REQUEST',
    }).catch((err) => logger.warn({ err, requestId }, 'Failed to notify requester of rejection'));

    logger.info({ requestId, actorEmpId, adminOverride }, 'Access request rejected');
    return;
  }

  // decision === 'APPROVE': check remaining pending approvals (admin override already cleared them)
  const pendingCount = await queryOne<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM access_request_approvals WHERE request_id = ? AND decision = 'PENDING'`,
    [requestId],
  );

  if ((pendingCount?.cnt ?? 0) > 0) {
    logger.info({ requestId, actorEmpId, pendingCount: pendingCount?.cnt }, 'Access request approved at this level, awaiting further approvals');
    return;
  }

  // All approved — fulfill the request
  await execute(
    `UPDATE access_requests SET status = 'APPROVED', decided_at = UTC_TIMESTAMP() WHERE id = ?`,
    [requestId],
  );

  let itemIds: string[] = [];
  try {
    itemIds = JSON.parse(request.item_ids) as string[];
  } catch {
    itemIds = [];
  }

  if (request.item_type === 'ENTITLEMENT') {
    const { fulfillEntitlementOnTarget } = await import('./entitlement-fulfillment.js');
    for (const itemId of itemIds) {
      await execute(
        `INSERT IGNORE INTO user_entitlements
           (emp_id, entitlement_id, source, granted_by, granted_at)
         VALUES (?, ?, 'REQUEST', ?, UTC_TIMESTAMP())`,
        [request.target_emp_id, itemId, actorEmpId],
      ).catch((err) => logger.warn({ err, requestId, itemId }, 'Failed to grant entitlement'));
      await fulfillEntitlementOnTarget(request.target_emp_id, itemId, 'GRANT', actorEmpId)
        .catch((err) => logger.warn({ err, requestId, itemId }, 'Entitlement target fulfill failed'));
    }
  }

  if (request.item_type === 'APP_ACCESS' && itemIds.length > 0) {
    const appId = itemIds[0]!;
    const tagGroupId = itemIds[1] ?? null;
    const workflow = await resolveWorkflowForRequest(appId, tagGroupId);
    await fulfillAppAccessRequest({
      targetEmpId:   request.target_emp_id,
      itemIds,
      grantedBy:     actorEmpId,
      requestId,
      autoProvision: workflow ? workflow.auto_provision === 1 : true,
    });
  }

  await execute(
    `UPDATE access_requests SET status = 'FULFILLED', fulfilled_at = UTC_TIMESTAMP() WHERE id = ?`,
    [requestId],
  );

  await sendNotification({
    recipientEmpId: request.requester_emp_id,
    channel:        'IN_APP',
    subject:        'Access Request Approved & Fulfilled',
    body:           adminOverride
      ? `Your access request (${requestId}) was approved by an administrator and fulfilled.`
      : `Your access request (${requestId}) has been approved and fulfilled.`,
    referenceId:    requestId,
    referenceType:  'ACCESS_REQUEST',
  }).catch((err) => logger.warn({ err, requestId }, 'Failed to notify requester of fulfillment'));

  logger.info({ requestId, actorEmpId, adminOverride }, 'Access request approved and fulfilled');
}
