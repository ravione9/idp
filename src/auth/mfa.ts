/**
 * MFA — TOTP enrollment and verification (RFC 6238).
 *
 * Uses otplib + Google-Authenticator-compatible 6-digit codes.
 * Backup codes are 8 random hex chars, hashed at rest with bcrypt.
 */
import { authenticator } from 'otplib';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { query, queryOne, transaction } from '../db/connection.js';
import logger from '../utils/logger.js';

authenticator.options = { window: 1, step: 30 };

const ISSUER = 'Lenskart IdP';

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
}

export async function getMfaStatus(empId: string): Promise<MfaStatus> {
  const row = await queryOne<MfaSecretRow>(
    'SELECT id, emp_id, secret_b32, enabled, enrolled_at, last_used_at, backup_codes FROM mfa_secrets WHERE emp_id = ?',
    [empId],
  );
  if (!row) {
    return { enrolled: false, enabled: false, remainingBackupCodes: 0, lastUsedAt: null };
  }
  let codes: string[] = [];
  if (row.backup_codes) {
    try {
      const raw = typeof row.backup_codes === 'string'
        ? JSON.parse(row.backup_codes)
        : row.backup_codes;
      if (Array.isArray(raw)) codes = raw as string[];
    } catch { /* ignore */ }
  }
  return {
    enrolled: true,
    enabled:  row.enabled === 1,
    remainingBackupCodes: codes.length,
    lastUsedAt: row.last_used_at,
  };
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
  const secret = authenticator.generateSecret();
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
  const otpauthUrl = authenticator.keyuri(accountLabel, ISSUER, secret);
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
  const valid = authenticator.check(code, row.secret_b32);
  if (!valid) throw new Error('Invalid code');

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
  logger.info({ empId }, 'MFA disabled');
}

/**
 * Verify a 6-digit TOTP code OR consume a backup code.
 * Returns true on success, false on failure.
 */
export async function verifyTotp(empId: string, code: string): Promise<boolean> {
  const row = await queryOne<MfaSecretRow>(
    'SELECT id, secret_b32, enabled, backup_codes FROM mfa_secrets WHERE emp_id = ?',
    [empId],
  );
  if (!row || row.enabled !== 1) return false;

  // Try TOTP first
  if (authenticator.check(code, row.secret_b32)) {
    await query(
      'UPDATE mfa_secrets SET last_used_at = UTC_TIMESTAMP() WHERE id = ?',
      [row.id],
    );
    return true;
  }

  // Try backup codes
  if (row.backup_codes) {
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
