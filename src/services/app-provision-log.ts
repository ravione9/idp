/**
 * Immutable audit log for application user provisioning / deprovisioning.
 * Records HTTP endpoints (SCIM or IdP internal) and response details.
 */

import { execute, queryOne } from '../db/connection.js';
import logger from '../utils/logger.js';

export type AppProvisionAction = 'PROVISION' | 'DEPROVISION';
export type AppProvisionStatus = 'SUCCESS' | 'FAILED' | 'SKIPPED';

export interface AppProvisionLogEntry {
  appId?: string | null;
  empId: string;
  action: AppProvisionAction;
  source?: string | null;
  httpMethod?: string | null;
  endpoint?: string | null;
  status: AppProvisionStatus;
  statusCode?: number | null;
  detail?: string | null;
  requestBody?: Record<string, unknown> | null;
  responseBody?: Record<string, unknown> | null;
  actorEmpId?: string | null;
  requestId?: string | null;
}

function trimJson(value: Record<string, unknown> | null | undefined): string | null {
  if (!value || !Object.keys(value).length) return null;
  return JSON.stringify(value);
}

export async function logAppProvision(entry: AppProvisionLogEntry): Promise<void> {
  try {
    await execute(
      `INSERT INTO app_provision_log
         (app_id, emp_id, action, source, http_method, endpoint, status, status_code,
          detail, request_body, response_body, actor_emp_id, request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.appId ?? null,
        entry.empId,
        entry.action,
        entry.source ?? null,
        entry.httpMethod ?? null,
        entry.endpoint ?? null,
        entry.status,
        entry.statusCode ?? null,
        entry.detail ? entry.detail.slice(0, 500) : null,
        trimJson(entry.requestBody ?? null),
        trimJson(entry.responseBody ?? null),
        entry.actorEmpId ?? null,
        entry.requestId ?? null,
      ],
    );
  } catch (err) {
    logger.warn({ err, action: entry.action, empId: entry.empId }, 'app_provision_log write failed');
  }
}

/** Log SAML assertion delivery to the SP ACS (e.g. Slack receives POST to acs_url). */
export async function logSamlAssertionProvision(params: {
  spId: string;
  empId: string;
  binding: 'REDIRECT' | 'POST' | 'IDP_INITIATED';
  relayState?: string;
  requestId?: string | null;
}): Promise<void> {
  const row = await queryOne<{
    app_id: string | null;
    acs_url: string;
    slo_url: string | null;
    slug: string;
    name: string;
    entity_id: string;
  }>(
    `SELECT a.id AS app_id, sp.acs_url, sp.slo_url, sp.slug, sp.name, sp.entity_id
       FROM saml_service_providers sp
       LEFT JOIN applications a ON a.slug = sp.slug
      WHERE sp.id = ?
      LIMIT 1`,
    [params.spId],
  );
  if (!row?.acs_url) return;

  let appId = row.app_id;
  if (!appId) {
    const { ensureSamlAppMirrored } = await import('./app-access-policy.js');
    await ensureSamlAppMirrored(row.slug).catch(() => undefined);
    const appRow = await queryOne<{ id: string }>(
      'SELECT id FROM applications WHERE slug = ? LIMIT 1',
      [row.slug],
    );
    appId = appRow?.id ?? null;
  }

  const httpMethod = params.binding === 'REDIRECT' ? 'GET' : 'POST';
  await logAppProvision({
    appId,
    empId: params.empId,
    action: 'PROVISION',
    source: 'SAML_ASSERTION',
    httpMethod,
    endpoint: row.acs_url,
    status: 'SUCCESS',
    statusCode: 200,
    detail: `SAML ${params.binding} assertion POST to ${row.name} ACS`,
    requestBody: {
      protocol: 'SAML',
      binding: params.binding,
      entityId: row.entity_id,
      launchPath: `/saml/launch/${row.slug}`,
      relayState: params.relayState ?? null,
      requestId: params.requestId ?? null,
    },
    responseBody: { protocol: 'SAML', spSlug: row.slug, sloUrl: row.slo_url },
  });
}
