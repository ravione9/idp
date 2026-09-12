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

const CREATE_APP_PROVISION_LOG_SQL = `
CREATE TABLE IF NOT EXISTS app_provision_log (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  app_id          VARCHAR(36)     DEFAULT NULL,
  emp_id          VARCHAR(20)     NOT NULL,
  action          ENUM('PROVISION','DEPROVISION') NOT NULL,
  source          VARCHAR(32)     DEFAULT NULL,
  http_method     VARCHAR(10)     DEFAULT NULL,
  endpoint        VARCHAR(1024)   DEFAULT NULL,
  status          ENUM('SUCCESS','FAILED','SKIPPED') NOT NULL,
  status_code     INT             DEFAULT NULL,
  detail          VARCHAR(500)    DEFAULT NULL,
  request_body    JSON            DEFAULT NULL,
  response_body   JSON            DEFAULT NULL,
  actor_emp_id    VARCHAR(20)     DEFAULT NULL,
  request_id      VARCHAR(36)     DEFAULT NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_apl_app (app_id, created_at DESC),
  KEY idx_apl_emp (emp_id, created_at DESC),
  KEY idx_apl_action (action, created_at DESC),
  KEY idx_apl_created (created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

let ensureTablePromise: Promise<void> | null = null;

/** Heal missing table when migration 064/065 has not been applied yet. */
export async function ensureAppProvisionLogTable(): Promise<void> {
  if (!ensureTablePromise) {
    ensureTablePromise = execute(CREATE_APP_PROVISION_LOG_SQL, [])
      .then(() => undefined)
      .catch((err) => {
        ensureTablePromise = null;
        throw err;
      });
  }
  await ensureTablePromise;
}

function isMissingTableError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  const msg = err instanceof Error ? err.message : String(err);
  return code === 'ER_NO_SUCH_TABLE' || /app_provision_log/i.test(msg) && /doesn't exist|does not exist/i.test(msg);
}

function trimJson(value: Record<string, unknown> | null | undefined): string | null {
  if (!value || !Object.keys(value).length) return null;
  return JSON.stringify(value);
}

export async function logAppProvision(entry: AppProvisionLogEntry): Promise<void> {
  const insert = () => execute(
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

  try {
    await insert();
  } catch (err) {
    if (isMissingTableError(err)) {
      try {
        await ensureAppProvisionLogTable();
        await insert();
        return;
      } catch (retryErr) {
        logger.warn({ err: retryErr, action: entry.action, empId: entry.empId }, 'app_provision_log write failed after heal');
        return;
      }
    }
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
