/**
 * MFA — TOTP enrollment and verification (RFC 6238).
 *
 * Uses otplib v13 + Google-Authenticator-compatible 6-digit codes.
 * Backup codes are 8 random hex chars, hashed at rest with bcrypt.
 */
import { generateSecret, generateURI, verify } from 'otplib';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { query, queryOne, transaction } from '../db/connection.js';
import logger from '../utils/logger.js';
import {
  buildMfaMethodDetails,
  clearMethodEnrollments,
  getAllowedMfaMethods,
  isAnyMfaEnabled,
  isMethodAllowed,
  type MfaMethodDetails,
  type MfaMethodKey,
} from './mfa-methods.js';
import { verifyAnyOtpLogin } from './mfa-otp.js';
import { deleteWebAuthnCredentials } from './mfa-webauthn.js';

/** Google Authenticator–compatible TOTP defaults. */
const TOTP_BASE = {
  strategy: 'totp' as const,
  digits: 6 as const,
  period: 30,
};

/** ±1 TOTP step — equivalent to v12 `window: 1`. */
const TOTP_VERIFY = { ...TOTP_BASE, epochTolerance: 30 };

const ISSUER = 'Lenskart IdP';

async function checkTotp(code: string, secret: string): Promise<boolean> {
  try {
    const result = await verify({ secret, token: code, ...TOTP_VERIFY });
    return result.valid;
  } catch {
    // SecretTooShortError / TokenError / malformed secret
    return false;
  }
}

export interface MfaSecretRow {
  id:           number;
  emp_id:       string;
  secret_b32:   string;
  enabled:      number;
  enrolled_at:  string | null;
  last_used_at: string | null;
  backup_codes: unknown;
}

export interface MfaStatus {
  enrolled: boolean;
  enabled:  boolean;
  remainingBackupCodes: number;
  lastUsedAt: string | null;
  methods?: MfaMethodKey[];
  allowedMethods?: MfaMethodKey[];
  methodDetails?: MfaMethodDetails;
}

export async function getMfaStatus(empId: string): Promise<MfaStatus> {
  const [row, emp, allowedMethods] = await Promise.all([
    queryOne<MfaSecretRow>(
      'SELECT id, emp_id, secret_b32, enabled, enrolled_at, last_used_at, backup_codes FROM mfa_secrets WHERE emp_id = ?',
      [empId],
    ),
    queryOne<{ email_corp: string; mobile: string | null }>(
      'SELECT email_corp, mobile FROM employees WHERE emp_id = ? LIMIT 1',
      [empId],
    ),
    getAllowedMfaMethods(empId),
  ]);

  let codes: string[] = [];
  let active = false;
  let lastUsedAt: string | null = null;

  if (row) {
    if (row.backup_codes) {
      try {
        const raw = typeof row.backup_codes === 'string'
          ? JSON.parse(row.backup_codes)
          : row.backup_codes;
        if (Array.isArray(raw)) codes = raw as string[];
      } catch { /* ignore */ }
    }
    active = row.enabled === 1;
    lastUsedAt = row.last_used_at;
  }

  const { methods, methodDetails } = await buildMfaMethodDetails(
    empId,
    active,
    active ? codes.length : 0,
    emp?.email_corp,
    emp?.mobile,
  );
  const enabled = await isAnyMfaEnabled(empId, active);

  return {
    enrolled: enabled,
    enabled,
    remainingBackupCodes: active ? codes.length : 0,
    lastUsedAt,
    methods,
    allowedMethods,
    methodDetails,
  };
}

/** Enrolled methods that are still allowed by policy — used for login challenge UI. */
export function challengeMethodsFromStatus(status: MfaStatus): MfaMethodKey[] {
  const allowed = new Set(status.allowedMethods ?? []);
  const enrolled = status.methods ?? [];
  const filtered = enrolled.filter((m) => allowed.has(m));
  return filtered.length ? filtered : (allowed.has('totp') ? ['totp'] : [...allowed].slice(0, 1));
}

export interface EnrollResult {
  secret:    string;
  otpauthUrl: string;
}

/**
 * Begin enrollment — creates a pending secret (enabled=0) and returns the
 * otpauth:// URL for QR rendering. User must call confirm() with a TOTP code
 * to enable.
 */
export async function startEnrollment(empId: string, accountLabel: string): Promise<EnrollResult> {
  if (!(await isMethodAllowed('totp', empId))) {
    throw new Error('Authenticator app (TOTP) is not allowed by MFA policy');
  }
  const secret = generateSecret();
  await query(
    `INSERT INTO mfa_secrets (emp_id, secret_b32, enabled)
       VALUES (?, ?, 0)
     ON DUPLICATE KEY UPDATE
       secret_b32 = VALUES(secret_b32),
       enabled    = 0,
       enrolled_at = NULL,
       backup_codes = NULL`,
    [empId, secret],
  );
  const otpauthUrl = generateURI({
    issuer: ISSUER,
    label: accountLabel,
    secret,
    ...TOTP_BASE,
  });
  return { secret, otpauthUrl };
}

/**
 * Confirm enrollment by verifying a code from the user's authenticator app.
 * Generates 8 backup codes (returned plain-text once), stores their hashes.
 */
export async function confirmEnrollment(empId: string, code: string): Promise<{ backupCodes: string[] }> {
  const row = await queryOne<MfaSecretRow>(
    'SELECT secret_b32 FROM mfa_secrets WHERE emp_id = ?',
    [empId],
  );
  if (!row) throw new Error('Start enrollment before confirming');
  if (!(await checkTotp(code, row.secret_b32))) throw new Error('Invalid code');

  const plain: string[] = [];
  const hashed: string[] = [];
  for (let i = 0; i < 8; i++) {
    const code = crypto.randomBytes(4).toString('hex');
    plain.push(code);
    hashed.push(await bcrypt.hash(code, 10));
  }

  await query(
    `UPDATE mfa_secrets
        SET enabled = 1,
            enrolled_at = UTC_TIMESTAMP(),
            backup_codes = ?
      WHERE emp_id = ?`,
    [JSON.stringify(hashed), empId],
  );

  logger.info({ empId }, 'MFA enrolled');
  return { backupCodes: plain };
}

export async function disableMfa(empId: string): Promise<void> {
  await query('DELETE FROM mfa_secrets WHERE emp_id = ?', [empId]);
  await clearMethodEnrollments(empId);
  await deleteWebAuthnCredentials(empId);
  logger.info({ empId }, 'MFA disabled (all methods)');
}

/**
 * Verify MFA using TOTP, backup codes, or enrolled OTP methods.
 * Respects mfa_policy.allowed_methods (disabled methods cannot satisfy a challenge).
 */
export async function verifyAnyMfaCode(empId: string, code: string): Promise<boolean> {
  const allowed = new Set(await getAllowedMfaMethods(empId));

  if (allowed.has('totp') || allowed.has('backup_codes')) {
    if (await verifyTotp(empId, code, {
      allowTotp: allowed.has('totp'),
      allowBackup: allowed.has('backup_codes'),
    })) {
      return true;
    }
  }

  if (allowed.has('email_otp') || allowed.has('sms_otp')) {
    const otpMethod = await verifyAnyOtpLogin(empId, code);
    if (otpMethod && allowed.has(otpMethod)) return true;
  }

  return false;
}

/**
 * Verify a 6-digit TOTP code OR consume a backup code.
 * Returns true on success, false on failure.
 */
export async function verifyTotp(
  empId: string,
  code: string,
  opts?: { allowTotp?: boolean; allowBackup?: boolean },
): Promise<boolean> {
  const allowTotp = opts?.allowTotp !== false;
  const allowBackup = opts?.allowBackup !== false;

  const row = await queryOne<MfaSecretRow>(
    'SELECT id, secret_b32, enabled, backup_codes FROM mfa_secrets WHERE emp_id = ?',
    [empId],
  );
  if (!row || row.enabled !== 1) return false;

  // Try TOTP first
  if (allowTotp && (await checkTotp(code, row.secret_b32))) {
    await query(
      'UPDATE mfa_secrets SET last_used_at = UTC_TIMESTAMP() WHERE id = ?',
      [row.id],
    );
    return true;
  }

  // Try backup codes
  if (allowBackup && row.backup_codes) {
    let codes: string[] = [];
    try {
      const raw = typeof row.backup_codes === 'string'
        ? JSON.parse(row.backup_codes)
        : row.backup_codes;
      if (Array.isArray(raw)) codes = raw as string[];
    } catch { /* ignore */ }

    for (let i = 0; i < codes.length; i++) {
      const codeHash = codes[i];
      if (!codeHash) continue;
      // eslint-disable-next-line no-await-in-loop
      if (await bcrypt.compare(code, codeHash)) {
        const remaining = [...codes.slice(0, i), ...codes.slice(i + 1)];
        await query(
          'UPDATE mfa_secrets SET backup_codes = ?, last_used_at = UTC_TIMESTAMP() WHERE id = ?',
          [JSON.stringify(remaining), row.id],
        );
        logger.info({ empId, remaining: remaining.length }, 'Backup code consumed');
        return true;
      }
    }
  }

  return false;
}

export async function regenerateBackupCodes(empId: string): Promise<string[]> {
  const row = await queryOne<MfaSecretRow>(
    'SELECT id, enabled FROM mfa_secrets WHERE emp_id = ?',
    [empId],
  );
  if (!row || row.enabled !== 1) {
    throw new Error('MFA is not enabled');
  }
  const plain: string[] = [];
  const hashed: string[] = [];
  for (let i = 0; i < 8; i++) {
    const code = crypto.randomBytes(4).toString('hex');
    plain.push(code);
    // eslint-disable-next-line no-await-in-loop
    hashed.push(await bcrypt.hash(code, 10));
  }
  await query(
    'UPDATE mfa_secrets SET backup_codes = ? WHERE id = ?',
    [JSON.stringify(hashed), row.id],
  );
  return plain;
}

/** Suppress unused-import warning when transaction helper isn't called here. */
void transaction;
