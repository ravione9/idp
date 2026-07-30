/**
 * Enforce the default (or named) password policy from `password_policies`.
 */
import bcrypt from 'bcryptjs';
import { query, queryOne } from '../db/connection.js';

export interface PasswordPolicyRow {
  id: string;
  min_length: number;
  require_uppercase: number;
  require_lowercase: number;
  require_digits: number;
  require_special: number;
  history_count: number;
  lockout_attempts: number;
  lockout_duration_min: number;
}

export async function getActivePasswordPolicy(): Promise<PasswordPolicyRow | null> {
  return queryOne<PasswordPolicyRow>(
    `SELECT id, min_length, require_uppercase, require_lowercase, require_digits,
            require_special, history_count, lockout_attempts, lockout_duration_min
       FROM password_policies
      ORDER BY is_default DESC, updated_at DESC
      LIMIT 1`,
    [],
  );
}

export function validatePasswordComplexity(
  password: string,
  policy: PasswordPolicyRow | null,
): string | null {
  const minLen = policy?.min_length ?? 10;
  if (password.length < minLen) {
    return `Password must be at least ${minLen} characters`;
  }
  if (policy?.require_uppercase && !/[A-Z]/.test(password)) {
    return 'Password must include an uppercase letter';
  }
  if (policy?.require_lowercase && !/[a-z]/.test(password)) {
    return 'Password must include a lowercase letter';
  }
  if (policy?.require_digits && !/\d/.test(password)) {
    return 'Password must include a digit';
  }
  if (policy?.require_special && !/[^A-Za-z0-9]/.test(password)) {
    return 'Password must include a special character';
  }
  return null;
}

/** Reject reuse of the last N password hashes for a local account. */
export async function assertPasswordNotInHistory(
  accountId: number,
  newPassword: string,
  historyCount: number,
): Promise<string | null> {
  if (historyCount <= 0) return null;

  const current = await queryOne<{ password_hash: string }>(
    `SELECT password_hash FROM local_accounts WHERE id = ?`,
    [accountId],
  );
  if (current && await bcrypt.compare(newPassword, current.password_hash)) {
    return 'New password must differ from the current password';
  }

  const rows = await query<{ password_hash: string }>(
    `SELECT password_hash FROM local_password_history
      WHERE account_id = ?
      ORDER BY changed_at DESC
      LIMIT ?`,
    [accountId, historyCount],
  );
  for (const row of rows) {
    if (await bcrypt.compare(newPassword, row.password_hash)) {
      return `Password was used recently — choose a different one (last ${historyCount} remembered)`;
    }
  }
  return null;
}

export async function enforcePasswordPolicy(
  password: string,
  opts?: { accountId?: number },
): Promise<string | null> {
  const policy = await getActivePasswordPolicy();
  const complexity = validatePasswordComplexity(password, policy);
  if (complexity) return complexity;
  if (opts?.accountId != null && policy) {
    return assertPasswordNotInHistory(opts.accountId, password, policy.history_count ?? 0);
  }
  return null;
}
