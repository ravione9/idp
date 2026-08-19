/**
 * AD Agent Sync — queue and reconcile sync jobs for on-prem Windows connectors.
 *
 * The IdP cannot reach AD LDAP ports through firewalls. An agent on the domain
 * network polls these jobs over HTTPS :443, runs LDAP locally, and posts results.
 */

import { v4 as uuidv4 } from 'uuid';
import { execute, queryOne } from '../db/connection.js';
import { hashAgentToken } from '../utils/agent-token.js';
import { timingSafeEqualString } from '../utils/timing-safe.js';
import logger from '../utils/logger.js';
import {
  resolveAdDirectoryConfig,
  type AdDirectoryConfig,
} from '../adapters/ad-adapter.js';
import {
  processInboundAdUsers,
  buildAdOutboundPlanForAgent,
  applyAdOutboundResultsFromAgent,
  type SyncResult,
  type AdOutboundAction,
  type AdOutboundResult,
} from './ad-sync.js';
import { config } from '../config.js';

export const AGENT_HEARTBEAT_TTL_MS = 5 * 60 * 1000;

export interface AgentJob {
  runId: string;
  connectorId: string;
  runType: string;
  direction: string;
  runInbound: boolean;
  runOutbound: boolean;
  dirConfig: AdDirectoryConfig;
  upnDomain?: string | undefined;
  syncGroups?: string | undefined;
  syncOrgUnits?: string | undefined;
  syncUsers?: string | undefined;
  includeSubOrgUnits?: boolean | undefined;
}

interface ConnectorRow {
  id: string;
  name: string;
  connector_type: string;
  direction: string;
  status: string;
  config_json: string | Record<string, unknown>;
}

function parseConfig(row: ConnectorRow | null): Record<string, unknown> {
  if (!row) return {};
  return typeof row.config_json === 'string'
    ? JSON.parse(row.config_json || '{}') as Record<string, unknown>
    : (row.config_json ?? {});
}

export async function loadAdAgentConnector(connectorId: string): Promise<ConnectorRow | null> {
  return queryOne<ConnectorRow>(
    `SELECT id, name, connector_type, direction, status, config_json
       FROM connectors
      WHERE id = ? AND UPPER(connector_type) = 'AD_AGENT'`,
    [connectorId],
  );
}

export function verifyAgentToken(cfg: Record<string, unknown>, rawToken: string): boolean {
  const stored = String(cfg['agentTokenHash'] ?? '').trim();
  if (!stored || !rawToken) return false;
  return timingSafeEqualString(hashAgentToken(rawToken), stored);
}

export async function recordAgentHeartbeat(
  connectorId: string,
  adReachable: boolean,
  adMessage: string,
  agentVersion?: string,
): Promise<void> {
  const ok = adReachable;
  await execute(
    `UPDATE connectors SET
       status = ?,
       last_error = ?,
       last_health_check_at = UTC_TIMESTAMP(),
       last_health_ok = ?,
       updated_at = UTC_TIMESTAMP()
     WHERE id = ? AND status != 'DISABLED'`,
    [
      ok ? 'CONNECTED' : 'ERROR',
      ok ? null : (adMessage || 'AD unreachable from agent').slice(0, 2000),
      ok ? 1 : 0,
      connectorId,
    ],
  );
  logger.info({ connectorId, adReachable, agentVersion }, 'AD agent heartbeat');
}

function resolveDirection(row: ConnectorRow): { runInbound: boolean; runOutbound: boolean } {
  const direction = (row.direction ?? 'BIDIRECTIONAL').toUpperCase();
  return {
    runInbound: direction === 'INBOUND' || direction === 'BIDIRECTIONAL',
    runOutbound: direction === 'OUTBOUND' || direction === 'BIDIRECTIONAL',
  };
}

function resolveDirConfig(cfg: Record<string, unknown>): AdDirectoryConfig {
  const baseDn = String(cfg['baseDn'] ?? config.ad.baseDn ?? '').trim();
  const targetOu = String(cfg['targetOu'] ?? '').trim();
  return resolveAdDirectoryConfig(baseDn, targetOu);
}

/** Queue a sync job for the on-prem agent (called by dispatcher / scheduler). */
export async function queueAdAgentSync(connectorId: string): Promise<SyncResult> {
  const row = await loadAdAgentConnector(connectorId);
  if (!row) throw new Error('AD Agent connector not found');

  const runId = uuidv4();
  const { runInbound, runOutbound } = resolveDirection(row);

  await execute(
    `INSERT INTO connector_runs
       (id, connector_id, run_type, status, started_at, items_processed, items_succeeded, items_failed, payload)
     VALUES (?, ?, 'INCREMENTAL', 'PENDING_AGENT', UTC_TIMESTAMP(), 0, 0, 0, ?)`,
    [runId, connectorId, JSON.stringify({ runInbound, runOutbound, queuedAt: new Date().toISOString() })],
  );

  logger.info({ connectorId, runId, runInbound, runOutbound }, 'AD agent sync queued');

  return {
    runId,
    connectorId,
    itemsProcessed: 0,
    itemsSucceeded: 0,
    itemsFailed: 0,
    errors: [],
  };
}

/** Return the oldest pending job for this connector (agent long-poll). */
export async function getPendingAgentJob(connectorId: string): Promise<AgentJob | null> {
  const row = await queryOne<{
    id: string;
    connector_id: string;
    run_type: string;
    payload: string | Record<string, unknown> | null;
  }>(
    `SELECT id, connector_id, run_type, payload
       FROM connector_runs
      WHERE connector_id = ? AND status = 'PENDING_AGENT'
      ORDER BY started_at ASC
      LIMIT 1`,
    [connectorId],
  );
  if (!row) return null;

  const conn = await loadAdAgentConnector(connectorId);
  if (!conn) return null;

  const cfg = parseConfig(conn);
  const payload = typeof row.payload === 'string'
    ? JSON.parse(row.payload || '{}') as Record<string, unknown>
    : (row.payload ?? {});

  const { runInbound, runOutbound } = resolveDirection(conn);
  const dirConfig = resolveDirConfig(cfg);
  const upnDomain = (cfg['upnDomain'] as string | undefined)?.trim()
    || (cfg['customerDomain'] as string | undefined)?.trim()
    || undefined;

  return {
    runId: row.id,
    connectorId,
    runType: row.run_type,
    direction: conn.direction,
    runInbound: Boolean(payload['runInbound'] ?? runInbound),
    runOutbound: Boolean(payload['runOutbound'] ?? runOutbound),
    dirConfig,
    upnDomain,
    syncGroups: String(cfg['syncGroups'] ?? ''),
    syncOrgUnits: String(cfg['syncOrgUnits'] ?? ''),
    syncUsers: String(cfg['syncUsers'] ?? ''),
    includeSubOrgUnits: cfg['includeSubOrgUnits'] !== false && cfg['includeSubOrgUnits'] !== 'false',
  };
}

export async function claimAgentJob(runId: string, connectorId: string): Promise<boolean> {
  const result = await execute(
    `UPDATE connector_runs
        SET status = 'RUNNING'
      WHERE id = ? AND connector_id = ? AND status = 'PENDING_AGENT'`,
    [runId, connectorId],
  );
  return result.affectedRows > 0;
}

export async function processAgentInbound(
  _runId: string,
  connectorId: string,
  users: Record<string, unknown>[],
): Promise<{ inbound: Awaited<ReturnType<typeof processInboundAdUsers>>; errors: string[] }> {
  const conn = await loadAdAgentConnector(connectorId);
  if (!conn) throw new Error('Connector not found');

  const cfg = parseConfig(conn);
  const dirConfig = resolveDirConfig(cfg);
  const errors: string[] = [];

  const inbound = await processInboundAdUsers(users, dirConfig, errors, { adapter: null, cfg });

  if (inbound.found === 0) {
    errors.push(
      `Inbound: 0 users received from agent under ${dirConfig.searchBaseDn}. ` +
      'Verify agent Base DN and LDAP search scope.',
    );
  }

  return { inbound, errors };
}

export async function getAgentOutboundPlan(connectorId: string): Promise<AdOutboundAction[]> {
  const conn = await loadAdAgentConnector(connectorId);
  if (!conn) throw new Error('Connector not found');
  const cfg = parseConfig(conn);
  const dirConfig = resolveDirConfig(cfg);
  return buildAdOutboundPlanForAgent(dirConfig, cfg);
}

export async function completeAgentJob(
  runId: string,
  connectorId: string,
  summary: {
    itemsProcessed: number;
    itemsSucceeded: number;
    itemsFailed: number;
    errorSummary?: string | null;
    inboundSummary?: string;
  },
): Promise<void> {
  const finalStatus = summary.itemsFailed > 0 ? 'PARTIAL' : 'SUCCESS';

  await execute(
    `UPDATE connector_runs
        SET status = ?, ended_at = UTC_TIMESTAMP(),
            items_processed = ?, items_succeeded = ?, items_failed = ?,
            error_summary = ?
      WHERE id = ? AND connector_id = ?`,
    [
      finalStatus,
      summary.itemsProcessed,
      summary.itemsSucceeded,
      summary.itemsFailed,
      summary.errorSummary ?? summary.inboundSummary ?? null,
      runId,
      connectorId,
    ],
  );

  await execute(
    `UPDATE connectors SET last_sync_at = UTC_TIMESTAMP(), last_error = ? WHERE id = ?`,
    [summary.itemsFailed > 0 ? (summary.errorSummary ?? 'Sync completed with errors').slice(0, 2000) : null, connectorId],
  );
}

export async function failAgentJob(
  runId: string,
  connectorId: string,
  message: string,
): Promise<void> {
  await execute(
    `UPDATE connector_runs
        SET status = 'FAILED', ended_at = UTC_TIMESTAMP(), error_summary = ?
      WHERE id = ? AND connector_id = ?`,
    [message.slice(0, 4000), runId, connectorId],
  );
  await execute(
    `UPDATE connectors SET last_error = ? WHERE id = ?`,
    [message.slice(0, 2000), connectorId],
  );
}

export async function applyAgentOutboundResults(
  results: AdOutboundResult[],
): Promise<{ processed: number; succeeded: number; failed: number; errors: string[] }> {
  return applyAdOutboundResultsFromAgent(results);
}

export async function processAgentGroups(
  connectorId: string,
  groups: import('./group-sync.js').AdAgentGroupPayload[],
): Promise<import('./group-sync.js').GroupSyncSummary> {
  const { processAdGroupsFromAgent } = await import('./group-sync.js');
  return processAdGroupsFromAgent(connectorId, groups);
}

export function isAgentRecentlyConnected(lastHealthCheckAt: Date | string | null): boolean {
  if (!lastHealthCheckAt) return false;
  const ts = lastHealthCheckAt instanceof Date ? lastHealthCheckAt.getTime() : Date.parse(String(lastHealthCheckAt));
  if (Number.isNaN(ts)) return false;
  return Date.now() - ts < AGENT_HEARTBEAT_TTL_MS;
}
