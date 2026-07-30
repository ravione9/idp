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

export interface MfaGroupPolicyRow {
  id: number;
  group_id: string;
  allowed_methods: unknown;
  enforce: number;
  active: number;
  notes: string | null;
  group_name?: string | null;
  source_system?: string | null;
  updated_at?: Date | string | null;
  updated_by?: string | null;
}

function normalizeMethods(raw: unknown): MfaMethodKey[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((k): k is MfaMethodKey =>
    typeof k === 'string' && (MFA_METHOD_KEYS as readonly string[]).includes(k),
  );
}

function parseMethodsJson(raw: unknown): MfaMethodKey[] {
  if (Array.isArray(raw)) return normalizeMethods(raw);
  if (typeof raw !== 'string') return [];
  try {
    return normalizeMethods(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** Org-wide ceiling from mfa_policy.allowed_methods (no group context). */
export async function getGlobalAllowedMfaMethods(): Promise<MfaMethodKey[]> {
  const row = await queryOne<{ policy_value: string }>(
    `SELECT policy_value FROM mfa_policy WHERE policy_key = 'allowed_methods' LIMIT 1`,
    [],
  ).catch(() => null);
  if (!row?.policy_value) return [...DEFAULT_ALLOWED];
  const parsed = parseMethodsJson(row.policy_value);
  return parsed.length ? parsed : [...DEFAULT_ALLOWED];
}

/**
 * Resolve allowed MFA methods for a user.
 * - Global policy is always the ceiling.
 * - If the user belongs to one or more groups with active mfa_group_policies,
 *   allowed = intersection(global, union(group policies)).
 * - Otherwise allowed = global.
 */
export async function getAllowedMfaMethods(empId?: string | null): Promise<MfaMethodKey[]> {
  const global = await getGlobalAllowedMfaMethods();
  if (!empId) return global;

  const groupRows = await query<{ allowed_methods: unknown }>(
    `SELECT p.allowed_methods
       FROM mfa_group_policies p
       JOIN group_members gm ON gm.group_id = (p.group_id COLLATE utf8mb4_unicode_ci)
      WHERE p.active = 1
        AND gm.emp_id = ?`,
    [empId],
  ).catch(() => [] as { allowed_methods: unknown }[]);

  if (!groupRows.length) return global;

  const union = new Set<MfaMethodKey>();
  for (const row of groupRows) {
    for (const m of parseMethodsJson(row.allowed_methods)) union.add(m);
  }
  if (union.size === 0) return [];

  return global.filter((m) => union.has(m));
}

export async function isMethodAllowed(
  method: MfaMethodKey,
  empId?: string | null,
): Promise<boolean> {
  const allowed = await getAllowedMfaMethods(empId);
  return allowed.includes(method);
}

/** True when any active group policy for this user has enforce=1. */
export async function isUserInEnforcedMfaGroup(empId: string): Promise<boolean> {
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM mfa_group_policies p
       JOIN group_members gm ON gm.group_id = (p.group_id COLLATE utf8mb4_unicode_ci)
      WHERE p.active = 1
        AND p.enforce = 1
        AND gm.emp_id = ?`,
    [empId],
  ).catch(() => null);
  return Number(row?.n ?? 0) > 0;
}

export async function listMfaGroupPolicies(): Promise<MfaGroupPolicyRow[]> {
  return query<MfaGroupPolicyRow>(
    `SELECT p.id, p.group_id, p.allowed_methods, p.enforce, p.active, p.notes,
            p.updated_at, p.updated_by,
            g.name AS group_name, g.source_system
       FROM mfa_group_policies p
       LEFT JOIN \`groups\` g ON g.id = (p.group_id COLLATE utf8mb4_unicode_ci)
      ORDER BY g.name IS NULL, g.name ASC, p.id ASC`,
    [],
  ).catch(() => [] as MfaGroupPolicyRow[]);
}

export function serializeGroupPolicy(row: MfaGroupPolicyRow): Record<string, unknown> {
  return {
    id: row.id,
    groupId: row.group_id,
    groupName: row.group_name ?? row.group_id,
    sourceSystem: row.source_system ?? 'LOCAL',
    allowedMethods: parseMethodsJson(row.allowed_methods),
    enforce: row.enforce === 1,
    active: row.active !== 0,
    notes: row.notes,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    updatedBy: row.updated_by,
  };
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
  ).catch(() => [] as MethodEnrollmentRow[]);
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
  ).catch(() => null);
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
  // Always expose corp email when present so login can offer Email OTP if policy allows
  if (emailRow || email) {
    methodDetails.email_otp = {
      enabled: !!emailRow,
      ...(email ? { email } : {}),
    };
  }

  const smsRow = enrollments.find((r) => r.method === 'sms_otp' && r.enabled === 1);
  const phone = mobile?.trim() || undefined;
  if (smsRow || phone) {
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
  ).catch(() => null);
  if ((extra?.n ?? 0) > 0) return true;
  const webauthn = await countWebAuthnCredentials(empId);
  return webauthn > 0;
}
