/**
 * Admin-initiated password reset — local account + AD/Google writeback.
 * Shared by single-user reset API and bulk CSV password update.
 */
import { queryOne, execute } from '../db/connection.js';
import { hashPassword } from './local-admin.js';
import { enforcePasswordPolicy } from './password-policy.js';
import { writebackPassword, ensureWritebackIdentityLinks } from './password-writeback.js';
import logger from '../utils/logger.js';

export interface PasswordSystemResult {
  system: string;
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  error?: string;
}

export interface AdminPasswordResetResult {
  empId: string;
  results: PasswordSystemResult[];
  success: boolean;
  partialFailure: boolean;
}

export async function resetEmployeePassword(params: {
  empId: string;
  newPassword: string;
  adminId: string;
}): Promise<AdminPasswordResetResult> {
  const { newPassword, adminId } = params;
  const requestedEmpId = params.empId;

  const policyErr = await enforcePasswordPolicy(newPassword);
  if (policyErr) {
    return {
      empId: requestedEmpId,
      results: [{ system: 'POLICY', status: 'FAILED', error: policyErr }],
      success: false,
      partialFailure: false,
    };
  }

  const employee = await queryOne<{ emp_id: string; email_corp: string | null }>(
    `SELECT emp_id, email_corp FROM employees WHERE emp_id = ?`,
    [requestedEmpId],
  );
  if (!employee) {
    return {
      empId: requestedEmpId,
      results: [{ system: 'LOCAL', status: 'FAILED', error: 'Employee not found' }],
      success: false,
      partialFailure: false,
    };
  }

  const empId = await ensureWritebackIdentityLinks(requestedEmpId);
  const localResults: PasswordSystemResult[] = [];

  const localAccount = await queryOne<{ id: number }>(
    `SELECT id FROM local_accounts WHERE emp_id = ? AND active = 1`,
    [empId],
  );
  const accountId = localAccount?.id;
  const historyPolicyErr = accountId != null
    ? await enforcePasswordPolicy(newPassword, { accountId })
    : null;
  if (historyPolicyErr) {
    return {
      empId,
      results: [{ system: 'POLICY', status: 'FAILED', error: historyPolicyErr }],
      success: false,
      partialFailure: false,
    };
  }

  const passwordHash = await hashPassword(newPassword);

  if (localAccount) {
    await execute(
      `UPDATE local_accounts SET password_hash = ? WHERE emp_id = ? AND active = 1`,
      [passwordHash, empId],
    );
    localResults.push({ system: 'LOCAL', status: 'SUCCESS' });
    logger.info({ empId, adminId }, 'Local password reset by admin');
  } else if (employee.email_corp) {
    const email = employee.email_corp.toLowerCase().trim();
    const emailTaken = await queryOne<{ emp_id: string }>(
      `SELECT emp_id FROM local_accounts WHERE email = ? AND active = 1`,
      [email],
    );
    if (emailTaken && emailTaken.emp_id !== empId) {
      localResults.push({
        system: 'LOCAL',
        status: 'FAILED',
        error: `Corporate email already tied to local account ${emailTaken.emp_id}`,
      });
    } else {
      const existingPortal = await queryOne<{ role: string }>(
        `SELECT role FROM local_accounts WHERE emp_id = ? AND active = 1`,
        [empId],
      );
      const localRole = existingPortal?.role ?? 'USER';
      await execute(
        `INSERT INTO local_accounts (emp_id, email, password_hash, role, created_by, active)
         VALUES (?, ?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), active = 1`,
        [empId, email, passwordHash, localRole, adminId],
      );
      localResults.push({ system: 'LOCAL', status: 'SUCCESS' });
      logger.info({ empId, adminId }, 'Local account provisioned during admin password reset');
    }
  } else {
    localResults.push({
      system: 'LOCAL',
      status: 'SKIPPED',
      error: 'No local login account and no corporate email on file',
    });
  }

  let writebackResults: PasswordSystemResult[] = [];
  try {
    writebackResults = await writebackPassword(empId, newPassword, adminId);
  } catch (err) {
    logger.warn({ empId, err }, 'Password writeback threw unexpectedly');
    writebackResults = [{ system: 'WRITEBACK', status: 'FAILED', error: String(err) }];
  }

  const allResults = [...localResults, ...writebackResults];
  const anySuccess = allResults.some((r) => r.status === 'SUCCESS');
  const anyFailed = allResults.some((r) => r.status === 'FAILED');

  return {
    empId,
    results: allResults,
    success: anySuccess,
    partialFailure: anySuccess && anyFailed,
  };
}
