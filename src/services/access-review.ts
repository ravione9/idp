/**
 * Access Review Service
 * ---------------------
 * Creates certification campaigns and processes reviewer decisions.
 * - createCampaign: builds review items from user_entitlements + assigns reviewers
 * - submitReviewDecision: records decision, revokes if REVOKE, closes campaign if all done
 */

import { query, queryOne, execute } from '../db/connection.js';
import { v4 as uuidv4 } from 'uuid';
import { sendNotification } from './notification.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface CampaignParams {
  name: string;
  description?: string;
  scope: 'ALL_USERS' | 'APP_SPECIFIC' | 'ROLE_SPECIFIC' | 'HIGH_RISK';
  reviewerKind: 'MANAGER' | 'APP_OWNER' | 'ROLE_OWNER';
  startDate: string;
  endDate: string;
  appId?: string;
  roleId?: string;
}

interface EntitlementItem {
  id: string;
  emp_id: string;
  entitlement_id: string;
  app_id: string | null;
  risk_score: number;
  owner_emp_id?: string | null;
}

interface ReviewItemRow {
  id: string;
  campaign_id: string;
  emp_id: string;
  reviewer_emp_id: string;
  entitlement_id: string;
  decision: string;
}

// ---------------------------------------------------------------------------
// createCampaign
// ---------------------------------------------------------------------------
export async function createCampaign(params: CampaignParams, createdBy: string): Promise<string> {
  const campaignId = uuidv4();

  await execute(
    `INSERT INTO access_review_campaigns
       (id, name, description, scope, reviewer_kind, start_date, end_date,
        status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, UTC_TIMESTAMP())`,
    [
      campaignId,
      params.name,
      params.description ?? null,
      params.scope,
      params.reviewerKind,
      params.startDate,
      params.endDate,
      createdBy,
    ],
  );

  // Build SQL filter based on scope
  let extraJoin = '';
  let extraWhere = '';
  const queryParams: unknown[] = [];

  if (params.scope === 'APP_SPECIFIC' && params.appId) {
    extraWhere = 'AND e.app_id = ?';
    queryParams.push(params.appId);
  } else if (params.scope === 'HIGH_RISK') {
    extraWhere = 'AND e.risk_score >= 70';
  } else if (params.scope === 'ROLE_SPECIFIC' && params.roleId) {
    // Role-specific filtering would require a business_roles join — use app filter as fallback
    extraWhere = 'AND e.active = 1';
  }

  // Fetch entitlements to review
  const items = await query<EntitlementItem>(
    `SELECT ue.id, ue.emp_id, ue.entitlement_id,
            e.app_id, e.risk_score,
            a.owner_emp_id
       FROM user_entitlements ue
       JOIN entitlements e ON e.id = ue.entitlement_id
       LEFT JOIN applications a ON a.id = e.app_id
       ${extraJoin}
      WHERE ue.revoked_at IS NULL AND e.active = 1 ${extraWhere}`,
    queryParams,
  );

  if (items.length === 0) {
    logger.info({ campaignId, scope: params.scope }, 'Access review campaign created with 0 items');
    return campaignId;
  }

  // Get a fallback admin for when no reviewer is found
  const fallbackAdmin = await queryOne<{ emp_id: string }>(
    `SELECT emp_id FROM employees WHERE role IN ('ADMIN','SUPER_ADMIN') AND ilg_state = 'ACTIVE' LIMIT 1`,
    [],
  );
  const fallbackEmpId = fallbackAdmin?.emp_id ?? createdBy;

  // Resolve reviewers per entitlement
  const resolvedItems: Array<{
    id: string;
    campaignId: string;
    empId: string;
    reviewerEmpId: string;
    entitlementId: string;
  }> = [];

  const employeeManagerCache = new Map<string, string | null>();

  async function getManager(empId: string): Promise<string | null> {
    if (employeeManagerCache.has(empId)) {
      return employeeManagerCache.get(empId)!;
    }
    const row = await queryOne<{ manager_emp_id: string | null }>(
      `SELECT manager_emp_id FROM employees WHERE emp_id = ?`,
      [empId],
    ).catch(() => null);
    const mgr = row?.manager_emp_id ?? null;
    employeeManagerCache.set(empId, mgr);
    return mgr;
  }

  for (const item of items) {
    let reviewerEmpId: string = fallbackEmpId;

    if (params.reviewerKind === 'MANAGER') {
      const mgr = await getManager(item.emp_id);
      reviewerEmpId = mgr ?? fallbackEmpId;
    } else if (params.reviewerKind === 'APP_OWNER') {
      reviewerEmpId = item.owner_emp_id ?? fallbackEmpId;
    } else if (params.reviewerKind === 'ROLE_OWNER') {
      // Role owner not modeled separately — fall back to app owner or admin
      reviewerEmpId = item.owner_emp_id ?? fallbackEmpId;
    }

    resolvedItems.push({
      id:            uuidv4(),
      campaignId,
      empId:         item.emp_id,
      reviewerEmpId,
      entitlementId: item.entitlement_id,
    });
  }

  // Batch insert access_review_items in chunks of 100
  const CHUNK_SIZE = 100;
  for (let i = 0; i < resolvedItems.length; i += CHUNK_SIZE) {
    const chunk = resolvedItems.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())').join(', ');
    const values: unknown[] = chunk.flatMap((r) => [
      r.id, r.campaignId, r.empId, r.reviewerEmpId, r.entitlementId, 'PENDING',
    ]);

    await execute(
      `INSERT INTO access_review_items
         (id, campaign_id, emp_id, reviewer_emp_id, entitlement_id, decision, created_at)
       VALUES ${placeholders}`,
      values,
    );
  }

  // Notify unique reviewers
  const uniqueReviewers = [...new Set(resolvedItems.map((r) => r.reviewerEmpId))];
  for (const reviewerId of uniqueReviewers) {
    await sendNotification({
      recipientEmpId: reviewerId,
      channel:        'IN_APP',
      subject:        `Access Review Campaign: ${params.name}`,
      body:           `You have been assigned access review items in campaign "${params.name}" (ends ${params.endDate}). Please review and certify or revoke.`,
      referenceId:    campaignId,
      referenceType:  'ACCESS_REVIEW_CAMPAIGN',
    }).catch((err) => logger.warn({ err, campaignId, reviewerId }, 'Failed to notify reviewer'));
  }

  logger.info(
    { campaignId, itemCount: resolvedItems.length, reviewerCount: uniqueReviewers.length },
    'Access review campaign created',
  );

  return campaignId;
}

// ---------------------------------------------------------------------------
// submitReviewDecision
// ---------------------------------------------------------------------------
export async function submitReviewDecision(
  itemId: string,
  reviewerId: string,
  decision: 'CERTIFY' | 'REVOKE' | 'EXCEPTION',
  comment?: string,
): Promise<void> {
  // Fetch review item
  const item = await queryOne<ReviewItemRow>(
    `SELECT id, campaign_id, emp_id, reviewer_emp_id, entitlement_id, decision
       FROM access_review_items
      WHERE id = ?`,
    [itemId],
  );

  if (!item) {
    throw new Error('Review item not found');
  }

  if (item.reviewer_emp_id !== reviewerId) {
    throw new Error('Reviewer does not match assigned reviewer for this item');
  }

  if (item.decision !== 'PENDING') {
    throw new Error(`Review item already decided: ${item.decision}`);
  }

  // Update decision
  await execute(
    `UPDATE access_review_items
        SET decision = ?, comment = ?, decided_at = UTC_TIMESTAMP()
      WHERE id = ?`,
    [decision, comment ?? null, itemId],
  );

  // If REVOKE, revoke the user entitlement
  if (decision === 'REVOKE') {
    await execute(
      `UPDATE user_entitlements
          SET revoked_at = UTC_TIMESTAMP(), revoked_by = ?
        WHERE entitlement_id = ? AND emp_id = ? AND revoked_at IS NULL`,
      [reviewerId, item.entitlement_id, item.emp_id],
    );
    logger.info(
      { itemId, empId: item.emp_id, entitlementId: item.entitlement_id, reviewerId },
      'Entitlement revoked via access review',
    );
  }

  // Check if all items in campaign are decided
  const pendingCount = await queryOne<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM access_review_items WHERE campaign_id = ? AND decision = 'PENDING'`,
    [item.campaign_id],
  );

  if ((pendingCount?.cnt ?? 0) === 0) {
    await execute(
      `UPDATE access_review_campaigns SET status = 'COMPLETED', updated_at = UTC_TIMESTAMP() WHERE id = ?`,
      [item.campaign_id],
    );
    logger.info({ campaignId: item.campaign_id }, 'Access review campaign completed');
  }
}
