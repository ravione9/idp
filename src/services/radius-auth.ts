/**
 * RADIUS / VPN authentication — shared by FreeRADIUS REST and UDP listener.
 * Verifies local/AD passwords, lifecycle, group policies, optional TOTP append.
 */
import { query, queryOne, execute } from '../db/connection.js';
import { findLocalAccountByEmail, verifyLocalPassword } from './local-admin.js';
import { authenticateAdCorporateUser } from './ad-auth.js';
import { isPortalAccessible } from '../fsm/states.js';
import { verifyTotp, getMfaStatus } from '../auth/mfa.js';
import { openSecret } from '../utils/secret-box.js';
import { ipMatchesCidr } from '../utils/ip-match.js';
import logger from '../utils/logger.js';

export type RadiusResult = 'ACCEPT' | 'REJECT' | 'CHALLENGE' | 'ERROR';
export type RadiusProtocol = 'REST' | 'UDP';

export interface RadiusAuthRequest {
  username: string;
  password: string;
  nasIp?: string | null;
  callingStationId?: string | null;
  /** Source IP of the RADIUS client (UDP peer or FreeRADIUS host) for client lookup */
  clientSourceIp?: string | null;
  protocol?: RadiusProtocol;
}

export interface RadiusAuthResponse {
  result: RadiusResult;
  reason?: string;
  empId?: string;
  reply?: Record<string, string>;
  clientId?: string | null;
  policyId?: string | null;
}

interface RadiusClientRow {
  id: string;
  name: string;
  nas_ip: string;
  shared_secret: string;
  client_type: string;
  vendor: string | null;
  active: number;
}

interface PolicyRow {
  id: string;
  name: string;
  priority: number;
  client_type: string;
  vendor: string | null;
  group_ids_json: unknown;
  require_mfa: number;
  require_mfa_enrolled: number;
  reply_attributes: unknown;
}

function parseJsonObj(raw: unknown): Record<string, string> {
  if (!raw) return {};
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try { v = JSON.parse(raw); } catch { return {}; }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val == null) continue;
    out[k] = String(val);
  }
  return out;
}

function parseGroupIds(raw: unknown): string[] {
  if (!raw) return [];
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try { v = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x)).filter(Boolean);
}

/** Split password vs TOTP: `pass\123456`, `pass,123456`, or trailing 6 digits. */
export function splitPasswordAndOtp(combined: string): { password: string; otp: string | null } {
  const s = combined ?? '';
  if (s.includes('\\')) {
    const i = s.lastIndexOf('\\');
    return { password: s.slice(0, i), otp: s.slice(i + 1) || null };
  }
  if (s.includes(',')) {
    const i = s.lastIndexOf(',');
    const right = s.slice(i + 1);
    if (/^\d{6}$/.test(right)) return { password: s.slice(0, i), otp: right };
  }
  if (s.length > 6 && /^\d{6}$/.test(s.slice(-6))) {
    return { password: s.slice(0, -6), otp: s.slice(-6) };
  }
  return { password: s, otp: null };
}

export async function findRadiusClient(
  nasIp?: string | null,
  clientSourceIp?: string | null,
): Promise<RadiusClientRow | null> {
  const rows = await query<RadiusClientRow>(
    `SELECT id, name, nas_ip, shared_secret, client_type, vendor, active
     FROM radius_clients WHERE active = 1 ORDER BY CHAR_LENGTH(nas_ip) DESC`,
    [],
  );
  const candidates = [nasIp, clientSourceIp].filter(Boolean) as string[];
  for (const ip of candidates) {
    for (const row of rows) {
      if (ipMatchesCidr(ip, row.nas_ip) || ip === row.nas_ip) return row;
    }
  }
  // Single catch-all client with nas_ip = * or 0.0.0.0/0
  return rows.find((r) => r.nas_ip === '*' || r.nas_ip === '0.0.0.0/0') ?? null;
}

export async function getRadiusClientSecret(clientId: string): Promise<string | null> {
  const row = await queryOne<{ shared_secret: string }>(
    `SELECT shared_secret FROM radius_clients WHERE id = ? AND active = 1`,
    [clientId],
  );
  if (!row) return null;
  try {
    return openSecret(row.shared_secret);
  } catch (err) {
    logger.error({ err, clientId }, 'Failed to open RADIUS shared secret');
    return null;
  }
}

async function userInAllowedGroups(empId: string, groupIds: string[]): Promise<boolean> {
  if (!groupIds.length) return true;
  const placeholders = groupIds.map(() => '?').join(',');
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM group_members
     WHERE emp_id = ? AND group_id IN (${placeholders})`,
    [empId, ...groupIds],
  );
  return Number(row?.n ?? 0) > 0;
}

async function pickPolicy(client: RadiusClientRow | null): Promise<PolicyRow | null> {
  const rows = await query<PolicyRow>(
    `SELECT id, name, priority, client_type, vendor, group_ids_json,
            require_mfa, require_mfa_enrolled, reply_attributes
     FROM radius_auth_policies
     WHERE active = 1
     ORDER BY priority ASC, created_at ASC`,
    [],
  );
  for (const p of rows) {
    if (p.client_type !== 'ANY' && client && p.client_type !== client.client_type) continue;
    if (p.vendor && client?.vendor && p.vendor !== client.vendor) continue;
    return p;
  }
  return rows[0] ?? null;
}

async function logAttempt(entry: {
  result: RadiusResult;
  reason?: string | null;
  username: string;
  empId?: string | null;
  nasIp?: string | null;
  clientId?: string | null;
  callingStationId?: string | null;
  policyId?: string | null;
  protocol: RadiusProtocol;
  reply?: Record<string, string> | null;
}): Promise<void> {
  try {
    await execute(
      `INSERT INTO radius_auth_log
         (result, reason, username, emp_id, nas_ip, client_id, calling_station_id, policy_id, protocol, reply_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.result,
        entry.reason ?? null,
        entry.username.slice(0, 255),
        entry.empId ?? null,
        entry.nasIp ?? null,
        entry.clientId ?? null,
        entry.callingStationId ?? null,
        entry.policyId ?? null,
        entry.protocol,
        entry.reply ? JSON.stringify(entry.reply) : null,
      ],
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to write radius_auth_log');
  }
}

export async function authenticateRadius(req: RadiusAuthRequest): Promise<RadiusAuthResponse> {
  const protocol: RadiusProtocol = req.protocol ?? 'REST';
  const username = (req.username || '').trim().toLowerCase();
  const nasIp = req.nasIp?.trim() || null;
  const callingStationId = req.callingStationId?.trim() || null;
  const clientIdOf = (c: RadiusClientRow | null) => c?.id ?? null;

  const fail = async (reason: string, extra: Partial<RadiusAuthResponse> = {}): Promise<RadiusAuthResponse> => {
    const out: RadiusAuthResponse = { result: 'REJECT', reason, ...extra };
    await logAttempt({
      result: 'REJECT',
      reason,
      username: username || '(empty)',
      nasIp,
      clientId: extra.clientId ?? null,
      callingStationId,
      policyId: extra.policyId ?? null,
      protocol,
      empId: extra.empId ?? null,
    });
    return out;
  };

  if (!username || !req.password) {
    return fail('missing-credentials');
  }

  const client = await findRadiusClient(nasIp, req.clientSourceIp);
  const policy = await pickPolicy(client);
  if (!policy) {
    return fail('no-policy', { clientId: clientIdOf(client) });
  }

  const groupIds = parseGroupIds(policy.group_ids_json);
  const requireMfa = !!policy.require_mfa;
  const requireEnrolled = !!policy.require_mfa_enrolled || requireMfa;

  let password = req.password;
  let otp: string | null = null;
  if (requireMfa) {
    const split = splitPasswordAndOtp(req.password);
    password = split.password;
    otp = split.otp;
    if (!otp) {
      return fail('mfa-required', { clientId: clientIdOf(client), policyId: policy.id });
    }
  }

  let account = await findLocalAccountByEmail(username);
  if (!account) {
    account = await authenticateAdCorporateUser(username, password);
    if (!account) {
      return fail('no-such-account', { clientId: clientIdOf(client), policyId: policy.id });
    }
  } else {
    const valid = await verifyLocalPassword(password, account.password_hash);
    if (!valid) {
      const ad = await authenticateAdCorporateUser(username, password);
      if (!ad) {
        return fail('bad-password', { clientId: clientIdOf(client), policyId: policy.id });
      }
      account = ad;
    }
  }

  if (!account.active) {
    return fail('account-inactive', { clientId: clientIdOf(client), policyId: policy.id, empId: account.emp_id });
  }
  if (!isPortalAccessible(account.ilg_state)) {
    return fail(`account-suspended:${account.ilg_state}`, {
      clientId: clientIdOf(client), policyId: policy.id, empId: account.emp_id,
    });
  }

  if (!(await userInAllowedGroups(account.emp_id, groupIds))) {
    return fail('group-denied', { clientId: clientIdOf(client), policyId: policy.id, empId: account.emp_id });
  }

  const mfa = await getMfaStatus(account.emp_id);
  if (requireEnrolled && !mfa.enabled) {
    return fail('mfa-not-enrolled', { clientId: clientIdOf(client), policyId: policy.id, empId: account.emp_id });
  }
  if (requireMfa && otp) {
    const ok = await verifyTotp(account.emp_id, otp, { allowBackup: true });
    if (!ok) {
      return fail('bad-otp', { clientId: clientIdOf(client), policyId: policy.id, empId: account.emp_id });
    }
  }

  const reply = parseJsonObj(policy.reply_attributes);
  const out: RadiusAuthResponse = {
    result: 'ACCEPT',
    empId: account.emp_id,
    reply,
    clientId: clientIdOf(client),
    policyId: policy.id,
  };
  await logAttempt({
    result: 'ACCEPT',
    reason: 'ok',
    username,
    empId: account.emp_id,
    nasIp,
    clientId: clientIdOf(client),
    callingStationId,
    policyId: policy.id,
    protocol,
    reply,
  });
  return out;
}
