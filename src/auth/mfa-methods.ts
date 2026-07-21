/**
 * MFA method registry — allowed methods (policy) and per-user enrollment state.
 */
import { query, queryOne } from '../db/connection.js';

export const MFA_METHOD_KEYS = [
  'totp',
  'backup_codes',
  'webauthn',
  'email_otp',
  'sms_otp',
] as const;

export type MfaMethodKey = typeof MFA_METHOD_KEYS[number];

const DEFAULT_ALLOWED: MfaMethodKey[] = ['totp', 'backup_codes', 'webauthn', 'email_otp', 'sms_otp'];

export interface MfaMethodDetails {
  totp?: { enabled: boolean };
  backup_codes?: { remaining: number };
  email_otp?: { enabled: boolean; email?: string };
  sms_otp?: { enabled: boolean; phone?: string; maskedPhone?: string };
  webauthn?: { enabled: boolean; credentials: number };
}

export async function getAllowedMfaMethods(): Promise<MfaMethodKey[]> {
  const row = await queryOne<{ policy_value: string }>(
    `SELECT policy_value FROM mfa_policy WHERE policy_key = 'allowed_methods' LIMIT 1`,
    [],
  );
  if (!row?.policy_value) return [...DEFAULT_ALLOWED];
  try {
    const parsed = JSON.parse(row.policy_value) as unknown;
    if (!Array.isArray(parsed)) return [...DEFAULT_ALLOWED];
    return parsed.filter((k): k is MfaMethodKey =>
      typeof k === 'string' && (MFA_METHOD_KEYS as readonly string[]).includes(k),
    );
  } catch {
    return [...DEFAULT_ALLOWED];
  }
}

export async function isMethodAllowed(method: MfaMethodKey): Promise<boolean> {
  const allowed = await getAllowedMfaMethods();
  return allowed.includes(method);
}

interface MethodEnrollmentRow {
  method: string;
  enabled: number;
  metadata: unknown;
}

export async function getMethodEnrollments(empId: string): Promise<MethodEnrollmentRow[]> {
  return query<MethodEnrollmentRow>(
    `SELECT method, enabled, metadata FROM mfa_method_enrollments WHERE emp_id = ?`,
    [empId],
  );
}

export async function setMethodEnrollment(
  empId: string,
  method: MfaMethodKey,
  enabled: boolean,
  metadata: Record<string, unknown> | null = null,
): Promise<void> {
  await query(
    `INSERT INTO mfa_method_enrollments (emp_id, method, enabled, enrolled_at, metadata)
       VALUES (?, ?, ?, IF(?, UTC_TIMESTAMP(), NULL), ?)
     ON DUPLICATE KEY UPDATE
       enabled = VALUES(enabled),
       enrolled_at = IF(VALUES(enabled) = 1, COALESCE(enrolled_at, UTC_TIMESTAMP()), NULL),
       metadata = VALUES(metadata)`,
    [empId, method, enabled ? 1 : 0, enabled ? 1 : 0, metadata ? JSON.stringify(metadata) : null],
  );
}

export async function clearMethodEnrollments(empId: string): Promise<void> {
  await query('DELETE FROM mfa_method_enrollments WHERE emp_id = ?', [empId]);
}

export async function countWebAuthnCredentials(empId: string): Promise<number> {
  const row = await queryOne<{ n: number }>(
    'SELECT COUNT(*) AS n FROM webauthn_credentials WHERE emp_id = ?',
    [empId],
  );
  return row?.n ?? 0;
}

export async function buildMfaMethodDetails(
  empId: string,
  totpEnabled: boolean,
  remainingBackupCodes: number,
  email?: string | null,
  mobile?: string | null,
): Promise<{ methods: MfaMethodKey[]; methodDetails: MfaMethodDetails }> {
  const enrollments = await getMethodEnrollments(empId);
  const webauthnCount = await countWebAuthnCredentials(empId);
  const methods: MfaMethodKey[] = [];
  const methodDetails: MfaMethodDetails = {};

  if (totpEnabled) {
    methods.push('totp');
    methodDetails.totp = { enabled: true };
  }
  if (totpEnabled && remainingBackupCodes > 0) {
    methods.push('backup_codes');
    methodDetails.backup_codes = { remaining: remainingBackupCodes };
  }

  for (const row of enrollments) {
    if (row.enabled !== 1) continue;
    const key = row.method as MfaMethodKey;
    if (!(MFA_METHOD_KEYS as readonly string[]).includes(key)) continue;
    if (!methods.includes(key)) methods.push(key);
  }

  if (webauthnCount > 0) {
    if (!methods.includes('webauthn')) methods.push('webauthn');
    methodDetails.webauthn = { enabled: true, credentials: webauthnCount };
  }

  const emailRow = enrollments.find((r) => r.method === 'email_otp' && r.enabled === 1);
  if (emailRow || methods.includes('email_otp')) {
    methodDetails.email_otp = {
      enabled: !!emailRow,
      ...(email ? { email } : {}),
    };
  }

  const smsRow = enrollments.find((r) => r.method === 'sms_otp' && r.enabled === 1);
  if (smsRow || methods.includes('sms_otp')) {
    const phone = mobile ?? undefined;
    const masked = phone ? maskPhone(phone) : undefined;
    methodDetails.sms_otp = {
      enabled: !!smsRow,
      ...(phone ? { phone } : {}),
      ...(masked ? { maskedPhone: masked } : {}),
    };
  }

  return { methods, methodDetails };
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '••••';
  return `•••• ${digits.slice(-4)}`;
}

export async function isAnyMfaEnabled(
  empId: string,
  totpEnabled: boolean,
): Promise<boolean> {
  if (totpEnabled) return true;
  const extra = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM mfa_method_enrollments WHERE emp_id = ? AND enabled = 1`,
    [empId],
  );
  if ((extra?.n ?? 0) > 0) return true;
  const webauthn = await countWebAuthnCredentials(empId);
  return webauthn > 0;
}
