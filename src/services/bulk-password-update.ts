/**
 * Bulk password update from CSV rows — validate + batch reset with AD/Google writeback.
 */
import { queryOne } from '../db/connection.js';
import { enforcePasswordPolicy } from './password-policy.js';
import { resetEmployeePassword } from './admin-password-reset.js';
import { getIdentityLinksForEmp } from '../utils/outbox.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const BULK_PASSWORD_TEMPLATE_HEADERS = ['email', 'new_password'] as const;

export interface BulkPasswordRowInput {
  line?: number;
  email?: string;
  empId?: string;
  employeeId?: string;
  newPassword: string;
}

export interface BulkPasswordRowResult {
  line?: number | undefined;
  email: string;
  empId?: string | undefined;
  action: 'updated' | 'failed' | 'skipped';
  systems?: { system: string; status: string; error?: string }[] | undefined;
  error?: string | undefined;
  code?: string | undefined;
}

export interface BulkPasswordValidationPreview {
  line?: number | undefined;
  email: string;
  empId?: string | undefined;
  valid: boolean;
  errors: string[];
  linkedSystems?: string[] | undefined;
}

export interface BulkPasswordValidationResult {
  valid: number;
  invalid: number;
  preview: BulkPasswordValidationPreview[];
}

export interface BulkPasswordBatchResult {
  processed: number;
  updated: number;
  failed: number;
  skipped: number;
  rows: BulkPasswordRowResult[];
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function displayEmail(row: BulkPasswordRowInput): string {
  return (row.email ?? '').trim();
}

export function bulkPasswordTemplateCsv(): string {
  return [
    BULK_PASSWORD_TEMPLATE_HEADERS.join(','),
    'user@company.com,SecurePass123!',
  ].join('\n');
}

async function resolveEmployee(
  row: BulkPasswordRowInput,
): Promise<{ empId: string; email: string } | null> {
  const empIdRaw = row.empId?.trim();
  if (empIdRaw) {
    const emp = await queryOne<{ emp_id: string; email_corp: string | null }>(
      `SELECT emp_id, email_corp FROM employees WHERE emp_id = ?`,
      [empIdRaw],
    );
    if (emp) {
      return { empId: emp.emp_id, email: emp.email_corp ?? displayEmail(row) };
    }
  }

  const employeeIdRaw = row.employeeId?.trim();
  if (employeeIdRaw) {
    const emp = await queryOne<{ emp_id: string; email_corp: string | null }>(
      `SELECT emp_id, email_corp FROM employees
        WHERE employee_number = ? OR emp_id = ?`,
      [employeeIdRaw, employeeIdRaw],
    );
    if (emp) {
      return { empId: emp.emp_id, email: emp.email_corp ?? displayEmail(row) };
    }
  }

  const emailRaw = row.email?.trim();
  if (emailRaw) {
    const email = normalizeEmail(emailRaw);
    const emp = await queryOne<{ emp_id: string; email_corp: string | null }>(
      `SELECT emp_id, email_corp FROM employees WHERE LOWER(email_corp) = ?`,
      [email],
    );
    if (emp) {
      return { empId: emp.emp_id, email: emp.email_corp ?? email };
    }
  }

  return null;
}

async function linkedSystemsForEmp(empId: string): Promise<string[]> {
  const links = await getIdentityLinksForEmp(empId);
  const systems = new Set<string>(['LOCAL']);
  for (const link of links) {
    if (link.status === 'ACTIVE') systems.add(link.system);
  }
  return [...systems];
}

export async function validateBulkPasswordRows(
  rows: BulkPasswordRowInput[],
): Promise<BulkPasswordValidationResult> {
  const preview: BulkPasswordValidationPreview[] = [];
  let valid = 0;
  let invalid = 0;

  for (const row of rows) {
    const errors: string[] = [];
    const email = displayEmail(row);
    const password = row.newPassword?.trim() ?? '';

    if (!password) {
      errors.push('new_password is required');
    } else {
      const policyErr = await enforcePasswordPolicy(password);
      if (policyErr) errors.push(policyErr);
    }

    if (!email && !row.empId?.trim() && !row.employeeId?.trim()) {
      errors.push('Provide email, emp_id, or employee_id');
    } else if (email && !EMAIL_RE.test(email)) {
      errors.push('Invalid email format');
    }

    let empId: string | undefined;
    let linkedSystems: string[] | undefined;

    if (errors.length === 0) {
      const resolved = await resolveEmployee(row);
      if (!resolved) {
        errors.push('User not found in directory');
      } else {
        empId = resolved.empId;
        linkedSystems = await linkedSystemsForEmp(resolved.empId);

        const localAccount = await queryOne<{ id: number }>(
          `SELECT id FROM local_accounts WHERE emp_id = ? AND active = 1`,
          [resolved.empId],
        );
        if (localAccount?.id != null) {
          const historyErr = await enforcePasswordPolicy(password, { accountId: localAccount.id });
          if (historyErr) errors.push(historyErr);
        }
      }
    }

    const rowValid = errors.length === 0;
    if (rowValid) valid++;
    else invalid++;

    preview.push({
      line: row.line,
      email: email || empId || row.employeeId || '',
      empId,
      valid: rowValid,
      errors,
      linkedSystems,
    });
  }

  return { valid, invalid, preview };
}

export async function processBulkPasswordBatch(
  rows: BulkPasswordRowInput[],
  adminId: string | null,
): Promise<BulkPasswordBatchResult> {
  const result: BulkPasswordBatchResult = {
    processed: 0,
    updated: 0,
    failed: 0,
    skipped: 0,
    rows: [],
  };

  for (const row of rows) {
    result.processed++;
    const email = displayEmail(row);
    const password = row.newPassword?.trim() ?? '';

    if (!password) {
      result.skipped++;
      result.rows.push({
        line: row.line,
        email,
        action: 'skipped',
        error: 'new_password is required',
        code: 'MISSING_PASSWORD',
      });
      continue;
    }

    const resolved = await resolveEmployee(row);
    if (!resolved) {
      result.failed++;
      result.rows.push({
        line: row.line,
        email,
        action: 'failed',
        error: 'User not found in directory',
        code: 'USER_NOT_FOUND',
      });
      continue;
    }

    const reset = await resetEmployeePassword({
      empId: resolved.empId,
      newPassword: password,
      adminId: adminId ?? 'admin',
    });

    if (!reset.success) {
      const policyResult = reset.results.find((r) => r.system === 'POLICY');
      result.failed++;
      result.rows.push({
        line: row.line,
        email: email || resolved.email,
        empId: reset.empId,
        action: 'failed',
        systems: reset.results,
        error: (policyResult?.error ?? reset.results.map((r) => r.error).filter(Boolean).join('; ')) || 'Password reset failed',
        code: policyResult ? 'PASSWORD_POLICY' : 'RESET_FAILED',
      });
      continue;
    }

    result.updated++;
    result.rows.push({
      line: row.line,
      email: email || resolved.email,
      empId: reset.empId,
      action: 'updated',
      systems: reset.results,
      error: reset.partialFailure
        ? reset.results.filter((r) => r.status === 'FAILED').map((r) => `${r.system}: ${r.error ?? 'failed'}`).join('; ')
        : undefined,
    });
  }

  return result;
}

/** Preload employees for duplicate-email detection in large batches (optional guard). */
export async function findDuplicateEmailsInBatch(rows: BulkPasswordRowInput[]): Promise<string[]> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const email = row.email?.trim().toLowerCase();
    if (!email) continue;
    counts.set(email, (counts.get(email) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([email]) => email);
}

/** Warn when the same emp_id appears more than once in one batch. */
export async function findDuplicateEmpIdsInBatch(rows: BulkPasswordRowInput[]): Promise<string[]> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const id = row.empId?.trim() || row.employeeId?.trim();
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id);
}
