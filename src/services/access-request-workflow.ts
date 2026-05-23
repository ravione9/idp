/**
 * Access Request Workflow
 * -----------------------
 * Handles the full lifecycle of access requests:
 * - Submit: SoD pre-check → insert request + approvals → notify approvers
 * - Decision: approve/reject → fulfill if all approved → notify requester
 */

import { queryOne, execute } from '../db/connection.js';
import { v4 as uuidv4 } from 'uuid';
import { evaluateSodForGrant } from './sod-evaluator.js';
import { sendNotification } from './notification.js';
import logger from '../utils/logger.js';

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
     VALUES (?, ?, ?, ?, ?, ?, 'PENDING_APPROVAL', UTC_TIMESTAMP(), ?)`,
    [
      reqId,
      params.requesterEmpId,
      params.targetEmpId,
      params.itemType,
      JSON.stringify(params.itemIds),
      params.justification,
      slaDue.toISOString().slice(0, 19).replace('T', ' '),
    ],
  );

  // Determine approvers
  const approvers: { level: number; empId: string }[] = [];

  // Level 1: manager of target employee (if available)
  const managerRow = await queryOne<{ manager_emp_id: string | null }>(
    `SELECT manager_emp_id FROM employees WHERE emp_id = ?`,
    [params.targetEmpId],
  ).catch(() => null); // graceful if column doesn't exist

  if (managerRow?.manager_emp_id) {
    approvers.push({ level: 1, empId: managerRow.manager_emp_id });
  }

  // Level 2: app owner for entitlements, or any ADMIN
  let level2Approver: string | null = null;

  if (params.itemType === 'ENTITLEMENT' && params.itemIds.length > 0) {
    const appOwner = await queryOne<{ owner_emp_id: string | null }>(
      `SELECT a.owner_emp_id
         FROM entitlements e
         JOIN applications a ON a.id = e.app_id
        WHERE e.id = ? AND a.owner_emp_id IS NOT NULL`,
      [params.itemIds[0]],
    ).catch(() => null);

    if (appOwner?.owner_emp_id) {
      level2Approver = appOwner.owner_emp_id;
    }
  }

  if (!level2Approver) {
    // Fallback: any ADMIN
    const admin = await queryOne<{ emp_id: string }>(
      `SELECT emp_id FROM employees WHERE role = 'ADMIN' AND ilg_state = 'ACTIVE' LIMIT 1`,
      [],
    ).catch(() => null);
    if (admin) {
      level2Approver = admin.emp_id;
    }
  }

  if (level2Approver) {
    // Avoid duplicate if manager IS the app owner
    const alreadyAdded = approvers.some((a) => a.empId === level2Approver);
    if (!alreadyAdded) {
      approvers.push({ level: approvers.length + 1, empId: level2Approver });
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
  return reqId;
}

// ---------------------------------------------------------------------------
// processDecision
// ---------------------------------------------------------------------------
export async function processDecision(
  requestId: string,
  approverId: string,
  decision: 'APPROVE' | 'REJECT',
  comment?: string,
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
  if (request.status !== 'PENDING_APPROVAL') {
    throw new Error(`Request is not in PENDING_APPROVAL state (current: ${request.status})`);
  }

  // Fetch the approval row for this approver
  const approval = await queryOne<ApprovalRow>(
    `SELECT id, request_id, level, approver_emp_id, decision
       FROM access_request_approvals
      WHERE request_id = ? AND approver_emp_id = ? AND decision = 'PENDING'`,
    [requestId, approverId],
  );

  if (!approval) {
    throw new Error('No pending approval found for this approver on this request');
  }

  // Update approval
  await execute(
    `UPDATE access_request_approvals
        SET decision = ?, comment = ?, decided_at = UTC_TIMESTAMP()
      WHERE id = ?`,
    [decision, comment ?? null, approval.id],
  );

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

    logger.info({ requestId, approverId }, 'Access request rejected');
    return;
  }

  // decision === 'APPROVE': check remaining pending approvals
  const pendingCount = await queryOne<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM access_request_approvals WHERE request_id = ? AND decision = 'PENDING'`,
    [requestId],
  );

  if ((pendingCount?.cnt ?? 0) > 0) {
    // More approvals needed — keep in PENDING_APPROVAL state
    logger.info({ requestId, approverId, pendingCount: pendingCount?.cnt }, 'Access request approved at this level, awaiting further approvals');
    return;
  }

  // All approved — fulfill the request
  await execute(
    `UPDATE access_requests SET status = 'APPROVED', decided_at = UTC_TIMESTAMP() WHERE id = ?`,
    [requestId],
  );

  // Fulfill entitlements
  if (request.item_type === 'ENTITLEMENT') {
    let itemIds: string[];
    try {
      itemIds = JSON.parse(request.item_ids) as string[];
    } catch {
      itemIds = [];
    }

    for (const itemId of itemIds) {
      await execute(
        `INSERT IGNORE INTO user_entitlements
           (id, emp_id, entitlement_id, source, granted_by, granted_at)
         VALUES (?, ?, ?, 'REQUEST', ?, UTC_TIMESTAMP())`,
        [uuidv4(), request.target_emp_id, itemId, approverId],
      ).catch((err) => logger.warn({ err, requestId, itemId }, 'Failed to grant entitlement'));
    }
  }

  await execute(
    `UPDATE access_requests SET status = 'FULFILLED', fulfilled_at = UTC_TIMESTAMP() WHERE id = ?`,
    [requestId],
  );

  await sendNotification({
    recipientEmpId: request.requester_emp_id,
    channel:        'IN_APP',
    subject:        'Access Request Approved & Fulfilled',
    body:           `Your access request (${requestId}) has been approved and fulfilled.`,
    referenceId:    requestId,
    referenceType:  'ACCESS_REQUEST',
  }).catch((err) => logger.warn({ err, requestId }, 'Failed to notify requester of fulfillment'));

  logger.info({ requestId, approverId }, 'Access request approved and fulfilled');
}
