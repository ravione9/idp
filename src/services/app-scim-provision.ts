/**
 * Application provisioning executor — SCIM outbound or SAML access-policy audit.
 * SAML apps (e.g. Slack) do not call a remote provision API; access is granted in the
 * IdP and the SP receives a SAML assertion at acs_url on SSO launch.
 */

import axios, { AxiosError } from 'axios';
import { query, queryOne } from '../db/connection.js';
import { logAppProvision } from './app-provision-log.js';
import { samlLaunchPath } from '../saml/launch-url.js';
import { openSecret } from '../utils/secret-box.js';
import logger from '../utils/logger.js';

interface ScimConfig {
  baseUrl: string;
  bearerToken: string;
  provisionPath?: string;
  deprovisionMode?: 'DELETE' | 'DEACTIVATE';
}

interface ScimUser {
  id?: string;
  userName?: string;
  active?: boolean;
  emails?: Array<{ value: string; primary?: boolean }>;
}

interface ScimListResponse {
  totalResults?: number;
  Resources?: ScimUser[];
}

function parseScimConfig(raw: unknown): ScimConfig | null {
  if (raw == null) return null;
  let cfg: Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      cfg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (typeof raw === 'object') {
    cfg = raw as Record<string, unknown>;
  } else {
    return null;
  }

  const baseUrl = String(cfg['baseUrl'] ?? cfg['scimBaseUrl'] ?? '').trim().replace(/\/+$/, '');
  const bearerToken = String(cfg['bearerToken'] ?? cfg['apiKey'] ?? cfg['token'] ?? '').trim();
  if (!baseUrl || !bearerToken) return null;

  let tokenPlain = bearerToken;
  try {
    tokenPlain = openSecret(bearerToken);
  } catch {
    /* keep raw token */
  }

  const deprovisionRaw = String(cfg['deprovisionMode'] ?? 'DEACTIVATE').toUpperCase();
  const deprovisionMode = deprovisionRaw === 'DELETE' ? 'DELETE' : 'DEACTIVATE';

  return {
    baseUrl,
    bearerToken: tokenPlain,
    provisionPath: String(cfg['provisionPath'] ?? '/Users').trim() || '/Users',
    deprovisionMode,
  };
}

function fullEndpoint(baseUrl: string, path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${baseUrl}${p}`;
}

async function scimCall(
  cfg: ScimConfig,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const url = fullEndpoint(cfg.baseUrl, path);
  const res = await axios.request({
    method,
    url,
    data: body,
    headers: {
      Authorization: `Bearer ${cfg.bearerToken}`,
      'Content-Type': 'application/scim+json',
      Accept: 'application/scim+json',
    },
    validateStatus: () => true,
    timeout: 30_000,
  });
  return { status: res.status, data: res.data };
}

function escapeScimFilterValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function isSlackScimEndpoint(baseUrl: string): boolean {
  return /slack\.com/i.test(baseUrl);
}

function scimUserMatchesEmail(user: ScimUser, email: string): boolean {
  const normalized = email.trim().toLowerCase();
  if ((user.userName ?? '').trim().toLowerCase() === normalized) return true;
  return (user.emails ?? []).some((e) => (e.value ?? '').trim().toLowerCase() === normalized);
}

async function findScimUserByFilter(cfg: ScimConfig, filter: string): Promise<ScimUser | null> {
  const path = `${cfg.provisionPath}?filter=${encodeURIComponent(filter)}&count=10`;
  try {
    const { status, data } = await scimCall(cfg, 'GET', path);
    if (status >= 400) {
      logger.warn({ status, filter, baseUrl: cfg.baseUrl }, 'SCIM user filter lookup failed');
      return null;
    }
    const list = data as ScimListResponse;
    return list.Resources?.[0] ?? null;
  } catch (err) {
    logger.warn({ err, filter, baseUrl: cfg.baseUrl }, 'SCIM user filter lookup error');
    return null;
  }
}

async function findScimUserByEmail(cfg: ScimConfig, email: string): Promise<ScimUser | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;

  const escaped = escapeScimFilterValue(normalized);
  const filters = isSlackScimEndpoint(cfg.baseUrl)
    ? [
      `email eq "${escaped}"`,
      `userName eq "${escaped}"`,
    ]
    : [
      `userName eq "${escaped}"`,
      `emails.value eq "${escaped}"`,
    ];

  for (const filter of filters) {
    const user = await findScimUserByFilter(cfg, filter);
    if (user?.id && scimUserMatchesEmail(user, normalized)) return user;
    if (user?.id && !isSlackScimEndpoint(cfg.baseUrl)) return user;
  }

  return null;
}

async function loadAppProvisionContext(appId: string): Promise<{
  app: { id: string; slug: string; name: string; provisioning: number };
  scim: ScimConfig | null;
  saml: {
    id: string;
    slug: string;
    name: string;
    acs_url: string;
    slo_url: string | null;
    entity_id: string;
  } | null;
} | null> {
  const app = await queryOne<{
    id: string;
    slug: string;
    name: string;
    provisioning: number;
  }>(
    `SELECT id, slug, name, provisioning FROM applications WHERE id = ? LIMIT 1`,
    [appId],
  );
  if (!app) return null;

  const scimRow = await queryOne<{ config: unknown }>(
    `SELECT config FROM app_protocol_configs
      WHERE app_id = ? AND protocol = 'SCIM' AND active = 1
      LIMIT 1`,
    [appId],
  );

  const saml = await queryOne<{
    id: string;
    slug: string;
    name: string;
    acs_url: string;
    slo_url: string | null;
    entity_id: string;
  }>(
    `SELECT id, slug, name, acs_url, slo_url, entity_id
       FROM saml_service_providers
      WHERE slug = ? AND active = 1
      LIMIT 1`,
    [app.slug],
  );

  return {
    app,
    scim: scimRow ? parseScimConfig(scimRow.config) : null,
    saml,
  };
}

async function logSamlAccessGrant(params: {
  ctx: NonNullable<Awaited<ReturnType<typeof loadAppProvisionContext>>>;
  emp: { email_corp: string | null; full_name: string | null };
  baseLog: {
    appId: string;
    empId: string;
    action: 'PROVISION';
    source: string;
    actorEmpId: string | null;
    requestId: string | null;
  };
}): Promise<void> {
  const { ctx, emp, baseLog } = params;
  const saml = ctx.saml!;
  const launch = samlLaunchPath(saml.slug);
  await logAppProvision({
    ...baseLog,
    httpMethod: 'POST',
    endpoint: saml.acs_url,
    status: 'SUCCESS',
    detail: `SAML access granted — user may SSO via ${launch}; assertion POST to SP ACS`,
    requestBody: {
      protocol: 'SAML',
      idpGrant: 'POST /api/admin/app-access-policy/assignments',
      launchPath: launch,
      entityId: saml.entity_id,
      email: emp.email_corp,
    },
    responseBody: {
      protocol: 'SAML',
      acsUrl: saml.acs_url,
      sloUrl: saml.slo_url,
      spEntityId: saml.entity_id,
    },
  });
}

async function logSamlAccessRevoke(params: {
  ctx: NonNullable<Awaited<ReturnType<typeof loadAppProvisionContext>>>;
  emp: { email_corp: string | null };
  baseLog: {
    appId: string;
    empId: string;
    action: 'DEPROVISION';
    source: string;
    actorEmpId: string | null;
    requestId: string | null;
  };
}): Promise<void> {
  const { ctx, emp, baseLog } = params;
  const saml = ctx.saml!;
  const launch = samlLaunchPath(saml.slug);
  await logAppProvision({
    ...baseLog,
    httpMethod: 'DELETE',
    endpoint: 'IdP: DELETE /api/admin/app-access-policy/assignments/:id',
    status: 'SUCCESS',
    detail: `SAML access revoked — ${launch} will deny; no assertion sent to ACS`,
    requestBody: {
      protocol: 'SAML',
      email: emp.email_corp,
      launchPath: launch,
      acsUrl: saml.acs_url,
    },
    responseBody: {
      protocol: 'SAML',
      acsUrl: saml.acs_url,
      sloUrl: saml.slo_url,
      note: 'Use SAML SLO for SP-side session termination when configured',
    },
  });
}

async function loadEmployee(empId: string): Promise<{
  emp_id: string;
  full_name: string | null;
  email_corp: string | null;
} | null> {
  return queryOne(
    `SELECT emp_id, full_name, email_corp FROM employees WHERE emp_id = ? LIMIT 1`,
    [empId],
  );
}

export interface AppProvisionParams {
  appId: string;
  empId: string;
  actorEmpId?: string | null;
  source?: string;
  requestId?: string | null;
}

/** Provision a user into a target application (SCIM when configured, SAML access grant otherwise). */
export async function provisionAppUser(params: AppProvisionParams): Promise<void> {
  const ctx = await loadAppProvisionContext(params.appId);
  const emp = await loadEmployee(params.empId);
  if (!ctx || !emp) return;

  const email = emp.email_corp?.trim().toLowerCase();
  const baseLog = {
    appId: ctx.app.id,
    empId: params.empId,
    action: 'PROVISION' as const,
    source: params.source ?? 'ADMIN',
    actorEmpId: params.actorEmpId ?? null,
    requestId: params.requestId ?? null,
  };

  // SAML SSO apps (Slack, etc.) — grant IdP access; assertion hits ACS on launch
  if (ctx.saml && !(ctx.app.provisioning && ctx.scim)) {
    await logSamlAccessGrant({ ctx, emp, baseLog });
    return;
  }

  if (!ctx.app.provisioning) {
    await logAppProvision({
      ...baseLog,
      httpMethod: 'POST',
      endpoint: 'IdP: POST /api/admin/app-access-policy/assignments',
      status: 'SUCCESS',
      detail: 'IdP access grant — no outbound SCIM provisioning enabled',
      requestBody: { appSlug: ctx.app.slug, email },
    });
    return;
  }

  if (!ctx.scim) {
    if (ctx.saml) {
      await logSamlAccessGrant({ ctx, emp, baseLog });
      return;
    }
    await logAppProvision({
      ...baseLog,
      httpMethod: 'POST',
      endpoint: 'IdP: POST /api/admin/app-access-policy/assignments',
      status: 'SUCCESS',
      detail: 'IdP access grant — no SCIM config on application',
      requestBody: { appSlug: ctx.app.slug, email },
    });
    return;
  }

  if (!email) {
    await logAppProvision({
      ...baseLog,
      status: 'FAILED',
      detail: 'Employee has no corporate email for SCIM provisioning',
    });
    return;
  }

  const existing = await findScimUserByEmail(ctx.scim, email);
  if (existing?.id) {
    if (existing.active === false) {
      const path = `${ctx.scim.provisionPath}/${existing.id}`;
      const patchBody = {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'replace', path: 'active', value: true }],
      };
      try {
        const { status, data } = await scimCall(ctx.scim, 'PATCH', path, patchBody);
        const ok = status >= 200 && status < 300;
        await logAppProvision({
          ...baseLog,
          httpMethod: 'PATCH',
          endpoint: fullEndpoint(ctx.scim.baseUrl, path),
          status: ok ? 'SUCCESS' : 'FAILED',
          statusCode: status,
          detail: ok ? `Reactivated SCIM user ${existing.id}` : `SCIM PATCH failed (${status})`,
          requestBody: patchBody,
          responseBody: typeof data === 'object' && data ? data as Record<string, unknown> : { raw: data },
        });
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await logAppProvision({
          ...baseLog,
          httpMethod: 'PATCH',
          endpoint: fullEndpoint(ctx.scim.baseUrl, path),
          status: 'FAILED',
          detail: msg,
          requestBody: patchBody,
        });
        return;
      }
    }

    await logAppProvision({
      ...baseLog,
      httpMethod: 'GET',
      endpoint: fullEndpoint(ctx.scim.baseUrl, `${ctx.scim.provisionPath}?filter=userName eq "${email}"`),
      status: 'SUCCESS',
      statusCode: 200,
      detail: `SCIM user already active (${existing.id})`,
      responseBody: { scimUserId: existing.id },
    });
    return;
  }

  const createBody = {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    userName: email,
    name: { formatted: emp.full_name ?? email },
    displayName: emp.full_name ?? email,
    active: true,
    emails: [{ value: email, primary: true, type: 'work' }],
  };

  try {
    const { status, data } = await scimCall(ctx.scim, 'POST', ctx.scim.provisionPath!, createBody);
    const ok = status >= 200 && status < 300;
    const scimUser = (typeof data === 'object' && data ? data as ScimUser : {});
    await logAppProvision({
      ...baseLog,
      httpMethod: 'POST',
      endpoint: fullEndpoint(ctx.scim.baseUrl, ctx.scim.provisionPath!),
      status: ok ? 'SUCCESS' : 'FAILED',
      statusCode: status,
      detail: ok
        ? `Created SCIM user ${scimUser.id ?? email}`
        : `SCIM POST failed (${status})`,
      requestBody: createBody,
      responseBody: typeof data === 'object' && data ? data as Record<string, unknown> : { raw: data },
    });
    if (!ok) {
      logger.warn({ appId: params.appId, empId: params.empId, status }, 'App SCIM provision failed');
    }
  } catch (err) {
    const axiosErr = err as AxiosError;
    const status = axiosErr.response?.status;
    await logAppProvision({
      ...baseLog,
      httpMethod: 'POST',
      endpoint: fullEndpoint(ctx.scim.baseUrl, ctx.scim.provisionPath!),
      status: 'FAILED',
      statusCode: status ?? null,
      detail: err instanceof Error ? err.message : String(err),
      requestBody: createBody,
      responseBody: axiosErr.response?.data && typeof axiosErr.response.data === 'object'
        ? axiosErr.response.data as Record<string, unknown>
        : null,
    });
  }
}

/** Deprovision a user from a target application (SCIM deactivate/delete or SAML access revoke). */
export async function deprovisionAppUser(params: AppProvisionParams): Promise<void> {
  const ctx = await loadAppProvisionContext(params.appId);
  const emp = await loadEmployee(params.empId);
  if (!ctx || !emp) return;

  const email = emp.email_corp?.trim().toLowerCase();
  const baseLog = {
    appId: ctx.app.id,
    empId: params.empId,
    action: 'DEPROVISION' as const,
    source: params.source ?? 'ADMIN',
    actorEmpId: params.actorEmpId ?? null,
    requestId: params.requestId ?? null,
  };

  if (ctx.saml && !(ctx.app.provisioning && ctx.scim)) {
    await logSamlAccessRevoke({ ctx, emp, baseLog });
    return;
  }

  if (!ctx.app.provisioning) {
    await logAppProvision({
      ...baseLog,
      httpMethod: 'DELETE',
      endpoint: 'IdP: DELETE /api/admin/app-access-policy/assignments/:id',
      status: 'SUCCESS',
      detail: 'IdP access revoke — no outbound SCIM deprovisioning enabled',
      requestBody: { appSlug: ctx.app.slug, email },
    });
    return;
  }

  if (!ctx.scim) {
    if (ctx.saml) {
      await logSamlAccessRevoke({ ctx, emp, baseLog });
      return;
    }
    await logAppProvision({
      ...baseLog,
      httpMethod: 'DELETE',
      endpoint: 'IdP: DELETE /api/admin/app-access-policy/assignments/:id',
      status: 'SUCCESS',
      detail: 'IdP access revoke — no SCIM config on application',
      requestBody: { appSlug: ctx.app.slug, email },
    });
    return;
  }

  if (!email) {
    await logAppProvision({
      ...baseLog,
      status: 'FAILED',
      detail: 'Employee has no corporate email for SCIM deprovisioning',
    });
    return;
  }

  const existing = await findScimUserByEmail(ctx.scim, email);
  if (!existing?.id) {
    await logAppProvision({
      ...baseLog,
      httpMethod: 'GET',
      endpoint: fullEndpoint(ctx.scim.baseUrl, `${ctx.scim.provisionPath}?filter=email eq "${email}"`),
      status: 'SKIPPED',
      statusCode: 404,
      detail: isSlackScimEndpoint(ctx.scim.baseUrl)
        ? 'SCIM user not found in Slack (searched by email and userName) — no deactivate call sent'
        : 'SCIM user not found — already absent from target app',
    });
    return;
  }

  const userPath = `${ctx.scim.provisionPath}/${existing.id}`;
  const useSlackDelete = isSlackScimEndpoint(ctx.scim.baseUrl);

  if (ctx.scim.deprovisionMode === 'DELETE' || useSlackDelete) {
    try {
      const { status, data } = await scimCall(ctx.scim, 'DELETE', userPath);
      const ok = status >= 200 && status < 300 || status === 404;
      await logAppProvision({
        ...baseLog,
        httpMethod: 'DELETE',
        endpoint: fullEndpoint(ctx.scim.baseUrl, userPath),
        status: ok ? 'SUCCESS' : 'FAILED',
        statusCode: status,
        detail: ok
          ? (useSlackDelete ? `Deactivated Slack user ${existing.id} (SCIM DELETE)` : `Deleted SCIM user ${existing.id}`)
          : `SCIM DELETE failed (${status})`,
        responseBody: typeof data === 'object' && data ? data as Record<string, unknown> : null,
      });
    } catch (err) {
      await logAppProvision({
        ...baseLog,
        httpMethod: 'DELETE',
        endpoint: fullEndpoint(ctx.scim.baseUrl, userPath),
        status: 'FAILED',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  const patchBody = {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
    Operations: [{ op: 'replace', path: 'active', value: false }],
  };
  try {
    const { status, data } = await scimCall(ctx.scim, 'PATCH', userPath, patchBody);
    const ok = status >= 200 && status < 300;
    await logAppProvision({
      ...baseLog,
      httpMethod: 'PATCH',
      endpoint: fullEndpoint(ctx.scim.baseUrl, userPath),
      status: ok ? 'SUCCESS' : 'FAILED',
      statusCode: status,
      detail: ok ? `Deactivated SCIM user ${existing.id}` : `SCIM PATCH failed (${status})`,
      requestBody: patchBody,
      responseBody: typeof data === 'object' && data ? data as Record<string, unknown> : { raw: data },
    });
  } catch (err) {
    await logAppProvision({
      ...baseLog,
      httpMethod: 'PATCH',
      endpoint: fullEndpoint(ctx.scim.baseUrl, userPath),
      status: 'FAILED',
      detail: err instanceof Error ? err.message : String(err),
      requestBody: patchBody,
    });
  }
}

/** Deprovision a user from every application with SCIM config (and optional audit when SCIM missing). */
export async function runApplicationDeprovisionForUser(params: {
  empId: string;
  actorEmpId?: string | null;
  source?: string;
  reason?: string;
  /** When true, write SKIPPED rows for SAML apps that have no SCIM token (manual admin action). */
  logSkippedSaml?: boolean;
}): Promise<{ scimApps: number; attempted: number; skippedSaml: number }> {
  const scimApps = await query<{ id: string; slug: string; name: string }>(
    `SELECT a.id, a.slug, a.name
       FROM applications a
      INNER JOIN app_protocol_configs c ON c.app_id = a.id AND c.protocol = 'SCIM' AND c.active = 1
      WHERE a.active = 1`,
    [],
  );

  let attempted = 0;
  for (const app of scimApps) {
    attempted++;
    await deprovisionAppUser({
      appId: app.id,
      empId: params.empId,
      actorEmpId: params.actorEmpId ?? null,
      source: params.source ?? 'LIFECYCLE',
    }).catch((err) =>
      logger.warn({ err, appId: app.id, slug: app.slug, empId: params.empId }, 'SCIM deprovision failed'),
    );
  }

  let skippedSaml = 0;
  const shouldLogSkippedSaml = params.logSkippedSaml !== false;
  if (shouldLogSkippedSaml) {
    const samlWithoutScim = await query<{ app_id: string | null; slug: string; name: string }>(
      `SELECT a.id AS app_id, sp.slug, sp.name
         FROM saml_service_providers sp
         LEFT JOIN applications a ON a.slug = sp.slug AND a.active = 1
         LEFT JOIN app_protocol_configs c ON c.app_id = a.id AND c.protocol = 'SCIM' AND c.active = 1
        WHERE sp.active = 1 AND c.id IS NULL`,
      [],
    );
    for (const app of samlWithoutScim) {
      skippedSaml++;
      await logAppProvision({
        appId: app.app_id,
        empId: params.empId,
        action: 'DEPROVISION',
        source: params.source ?? 'ADMIN',
        httpMethod: 'DELETE',
        endpoint: `IdP: SCIM not configured for ${app.slug}`,
        status: 'SKIPPED',
        detail: `${app.name}: SAML SSO only — add SCIM token in Applications → SAML → Edit to deactivate users inside ${app.name}`,
        actorEmpId: params.actorEmpId ?? null,
        responseBody: { protocol: 'SAML', spSlug: app.slug, scimConfigured: false },
      });
    }
  }

  if (!scimApps.length && !skippedSaml) {
    logger.warn(
      { empId: params.empId, source: params.source },
      'Application deprovision: no SAML or SCIM-configured apps found',
    );
  }

  return { scimApps: scimApps.length, attempted, skippedSaml };
}

/** @deprecated use runApplicationDeprovisionForUser */
export async function deprovisionUserFromAllScimApps(params: {
  empId: string;
  actorEmpId?: string | null;
  source?: string;
  reason?: string;
}): Promise<void> {
  await runApplicationDeprovisionForUser({
    empId: params.empId,
    actorEmpId: params.actorEmpId ?? null,
    source: params.source ?? 'LIFECYCLE',
    ...(params.reason !== undefined ? { reason: params.reason } : {}),
  });
}
