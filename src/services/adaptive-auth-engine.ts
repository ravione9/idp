/**
 * Adaptive Authentication Engine
 *
 * Evaluates login-time risk signals against active policies from
 * adaptive_auth_policies. Returns the highest-severity decision:
 *   BLOCK > STEP_UP > MFA > ALLOW
 *
 * Supported condition types (all ANDed within a policy):
 *   IP_RANGE        { values: string[] }                        IP prefix/CIDR match
 *   NETWORK_TYPE    { values: ('CORPORATE'|'EXTERNAL'|'TOR'|'PROXY')[] }
 *   DEVICE_MANAGED  { value: 'true'|'false' }                   MDM device check (corporate IP = managed proxy)
 *   NEW_DEVICE      {}                                          Device not seen before for this user
 *   IMPOSSIBLE_TRAVEL {}                                        Country change in < 4 h since last session
 *   COUNTRY         { op: 'in'|'not_in', values: string[] }     ISO 3166-1 alpha-2 codes
 *   USER_ROLE       { values: string[] }                        Role match
 *   RISK_SCORE      { op: 'gt'|'gte'|'lt'|'lte', value: number } Computed 0–100 score
 *   SENSITIVE_APP   {}                                          App category is Finance/HR/ERP/CRM/PAM/Administration
 *   TOR_PROXY       {}                                          IP flagged as hosting/proxy by ip-api.com
 */

import { query, queryOne } from '../db/connection.js';
import { parseUserAgent } from '../utils/ua-parser.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AdaptiveAction = 'ALLOW' | 'MFA' | 'STEP_UP' | 'BLOCK';

export interface LoginContext {
  ip:        string;
  email:     string;
  userAgent: string;
  role:      string;
  empId:     string;
  appId?:    string;
}

export interface EvaluationResult {
  action:          AdaptiveAction;
  matchedPolicies: { id: string; name: string; action: string }[];
  riskScore:       number;
  signals:         string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ACTION_RANK: Record<string, number> = { ALLOW: 0, MFA: 1, STEP_UP: 2, DENY: 2, BLOCK: 3 };

const PRIVILEGED_ROLES = new Set(['ADMIN', 'SUPER_ADMIN', 'IT_OPS', 'SECURITY']);

// ISO 3166-1 alpha-2 codes for countries with elevated geopolitical risk
const HIGH_RISK_COUNTRIES = new Set([
  'CN', 'RU', 'KP', 'IR', 'BY', 'CU', 'SD', 'SY', 'VE', 'LY', 'MM', 'AF',
]);

// Application categories treated as sensitive
const SENSITIVE_APP_CATEGORIES = new Set([
  'Finance', 'HR', 'ERP', 'CRM', 'PAM', 'Administration', 'Admin',
]);

const PRIVATE_IP_RE = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^::1$/,
  /^fc00:/i,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPrivateIp(ip: string): boolean {
  return PRIVATE_IP_RE.some((r) => r.test(ip));
}

interface GeoResult {
  countryCode: string;
  country:     string;
  city:        string;
  isProxy:     boolean;
  isHosting:   boolean;
}

/**
 * Synchronous geo lookup during policy evaluation (unlike ip-geo.ts which is
 * fire-and-forget). Times out at 4 s; returns null on any failure.
 *
 * Free ip-api.com: `hosting` = VPS/datacenter/Tor exit. `proxy` = HTTP proxy.
 * Both are free-tier fields despite the docs confusion.
 */
async function fetchGeo(ip: string): Promise<GeoResult | null> {
  if (!ip || isPrivateIp(ip)) return null;
  try {
    const url  = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,city,proxy,hosting`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!resp.ok) return null;
    const d = await resp.json() as {
      status:      string;
      country?:    string;
      countryCode?: string;
      city?:       string;
      proxy?:      boolean;
      hosting?:    boolean;
    };
    if (d.status !== 'success') return null;
    return {
      countryCode: d.countryCode ?? '',
      country:     d.country    ?? '',
      city:        d.city       ?? '',
      isProxy:     d.proxy      ?? false,
      isHosting:   d.hosting    ?? false,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core evaluator
// ---------------------------------------------------------------------------

export async function evaluateAdaptiveAuth(ctx: LoginContext): Promise<EvaluationResult> {
  const deviceInfo  = parseUserAgent(ctx.userAgent);
  const privateIp   = isPrivateIp(ctx.ip);
  const isPrivileged = PRIVILEGED_ROLES.has(ctx.role.toUpperCase());

  // ── Parallel I/O: geo lookup + DB queries ───────────────────────────────

  const [geo, prevDeviceRows, lastSession, appRow, policies] = await Promise.all([
    // 1. Synchronous geo (only for external IPs)
    privateIp ? Promise.resolve(null) : fetchGeo(ctx.ip),

    // 2. Distinct device_info seen for this user in prior non-expired sessions
    query<{ device_info: string }>(
      `SELECT DISTINCT device_info
         FROM idp_sessions
        WHERE emp_id = ?
          AND device_info IS NOT NULL
          AND expires_at > UTC_TIMESTAMP()
          AND revoked_at IS NULL
        LIMIT 100`,
      [ctx.empId],
    ),

    // 3. Most-recent previous session (for impossible travel)
    queryOne<{ geo_location: string | null; created_at: string }>(
      `SELECT geo_location, created_at
         FROM idp_sessions
        WHERE emp_id = ?
          AND revoked_at IS NULL
          AND expires_at > UTC_TIMESTAMP()
        ORDER BY created_at DESC
        LIMIT 1`,
      [ctx.empId],
    ),

    // 4. App sensitivity check (only when appId provided)
    ctx.appId
      ? queryOne<{ category: string | null }>(
          'SELECT category FROM applications WHERE id = ? AND active = 1',
          [ctx.appId],
        )
      : Promise.resolve(null),

    // 5. Active policies ordered by priority (lower = first)
    query<{
      id:               string;
      name:             string;
      priority:         number;
      conditions_json:  string;
      action:           string;
      scope:            string;
      app_ids_json:     string | null;
      group_ids_json:   string | null;
    }>(
      `SELECT id, name, priority, conditions_json, action, scope, app_ids_json, group_ids_json
         FROM adaptive_auth_policies
        WHERE active = 1
        ORDER BY priority ASC`,
      [],
    ),
  ]);

  // ── Compute risk signals ──────────────────────────────────────────────────

  const signals: string[] = [];
  let riskScore = 0;

  // Known devices for this user
  const knownDevices = new Set(prevDeviceRows.map((r) => r.device_info));
  const isNewDevice  = knownDevices.size > 0 && !knownDevices.has(deviceInfo);
  if (isNewDevice) { riskScore += 20; signals.push('new_device'); }

  // Geo-based signals
  const countryCode  = geo?.countryCode ?? '';
  const isHighRiskCountry = countryCode !== '' && HIGH_RISK_COUNTRIES.has(countryCode);
  if (isHighRiskCountry)   { riskScore += 30; signals.push(`high_risk_country:${countryCode}`); }

  const isTorProxy = (geo?.isProxy ?? false) || (geo?.isHosting ?? false);
  if (isTorProxy)          { riskScore += 30; signals.push('tor_proxy'); }

  // Impossible travel: country changed within 4 hours since last active session
  let isImpossibleTravel = false;
  if (lastSession?.geo_location && geo?.country) {
    const lastCountry = lastSession.geo_location.split('·').pop()?.trim() ?? '';
    const msSince     = Date.now() - new Date(lastSession.created_at).getTime();
    if (lastCountry && lastCountry !== geo.country && msSince < 4 * 3_600_000) {
      isImpossibleTravel = true;
      riskScore += 25;
      signals.push(`impossible_travel:${lastCountry}->${geo.country}`);
    }
  }

  const isSensitiveApp =
    appRow?.category !== undefined &&
    appRow.category !== null &&
    SENSITIVE_APP_CATEGORIES.has(appRow.category);

  if (isPrivileged)               signals.push('privileged_user');
  if (!privateIp)                 signals.push('external_network');
  if (isSensitiveApp)             signals.push('sensitive_app');

  // ── Policy evaluation ─────────────────────────────────────────────────────

  type ConditionObj = {
    type:    string;
    op?:     string;
    value?:  string | number;
    values?: string[];
  };

  const matchedPolicies: { id: string; name: string; action: string }[] = [];
  let finalAction: AdaptiveAction = 'ALLOW';

  for (const policy of policies) {
    // Scope: skip APP_SPECIFIC policies that don't cover the current app
    if (policy.scope === 'APP_SPECIFIC') {
      const ids: string[] = policy.app_ids_json ? JSON.parse(policy.app_ids_json) as string[] : [];
      if (!ctx.appId || !ids.includes(ctx.appId)) continue;
    }

    const conditions: ConditionObj[] =
      typeof policy.conditions_json === 'string'
        ? JSON.parse(policy.conditions_json) as ConditionObj[]
        : (policy.conditions_json as unknown as ConditionObj[]);

    // All conditions must pass (AND semantics)
    let allPass = true;
    for (const cond of conditions) {
      let pass = false;

      switch (cond.type) {

        case 'IP_RANGE': {
          // Accept full CIDR or prefix; do a string-prefix match on the first
          // two or three octets — sufficient for /8, /16, /24 corporate ranges.
          const prefixes = cond.values ?? [];
          pass = prefixes.some((cidr) => {
            const base   = cidr.split('/')[0] ?? '';
            const parts  = base.split('.').filter(Boolean);
            const prefix = parts.slice(0, Math.max(2, parts.length - 1)).join('.');
            return ctx.ip.startsWith(prefix);
          });
          break;
        }

        case 'NETWORK_TYPE': {
          const types = (cond.values ?? []).map((v) => v.toUpperCase());
          if (types.includes('CORPORATE') && privateIp)          pass = true;
          if (types.includes('EXTERNAL')  && !privateIp)         pass = true;
          if (types.includes('TOR')       && (geo?.isHosting ?? false)) pass = true;
          if (types.includes('PROXY')     && (geo?.isProxy   ?? false)) pass = true;
          break;
        }

        case 'DEVICE_MANAGED': {
          // Without an MDM agent, we approximate: private-IP access = managed.
          const isManaged = privateIp;
          const wantManaged = String(cond.value).toLowerCase() === 'true';
          pass = isManaged === wantManaged;
          break;
        }

        case 'NEW_DEVICE':       { pass = isNewDevice;       break; }
        case 'IMPOSSIBLE_TRAVEL':{ pass = isImpossibleTravel; break; }
        case 'SENSITIVE_APP':    { pass = isSensitiveApp;    break; }
        case 'TOR_PROXY':        { pass = isTorProxy;        break; }

        case 'COUNTRY': {
          const codes  = (cond.values ?? []).map((v) => v.toUpperCase());
          const inList = codes.includes(countryCode.toUpperCase());
          pass = cond.op === 'not_in' ? !inList : inList;
          break;
        }

        case 'USER_ROLE': {
          const roles = (cond.values ?? []).map((v) => v.toUpperCase());
          pass = roles.includes(ctx.role.toUpperCase());
          break;
        }

        case 'RISK_SCORE': {
          const threshold = Number(cond.value);
          switch (cond.op) {
            case 'gt':  pass = riskScore >  threshold; break;
            case 'gte': pass = riskScore >= threshold; break;
            case 'lt':  pass = riskScore <  threshold; break;
            case 'lte': pass = riskScore <= threshold; break;
          }
          break;
        }

        default:
          // Unknown condition type — treat as satisfied so new types don't
          // silently block everything while the engine is being extended.
          pass = true;
      }

      if (!pass) { allPass = false; break; }
    }

    if (allPass) {
      matchedPolicies.push({ id: policy.id, name: policy.name, action: policy.action });
      const rank = ACTION_RANK[policy.action] ?? 0;
      if (rank > (ACTION_RANK[finalAction] ?? 0)) {
        finalAction = policy.action as AdaptiveAction;
      }
    }
  }

  // Hard override: privileged users always require at least MFA regardless of
  // which policies matched (or if no policy matched).
  if (isPrivileged && (ACTION_RANK[finalAction] ?? 0) < ACTION_RANK['MFA']!) {
    finalAction = 'MFA';
    if (!signals.includes('privileged_user')) signals.push('privileged_user');
  }

  logger.info({
    empId:        ctx.empId,
    ip:           ctx.ip,
    role:         ctx.role,
    deviceInfo,
    countryCode,
    riskScore,
    signals,
    action:       finalAction,
    matchedCount: matchedPolicies.length,
  }, 'adaptive-auth evaluation');

  return { action: finalAction, matchedPolicies, riskScore, signals };
}
