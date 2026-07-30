/**
 * LILG Outbox Worker
 * -----------------
 * Drains the adapter_outbox table, dispatching operations to registered
 * adapters. Implements:
 *   - Redis SET NX PX leader election (only one worker drains at a time)
 *   - Exponential back-off on retryable errors
 *   - Dead-letter after max_attempts
 *   - Per-system concurrency semaphore via Redis counter
 *   - Graceful shutdown on SIGTERM / SIGINT
 */

import { Redis } from 'ioredis';
import { query, pool } from '../db/connection.js';
import { config } from '../config.js';
import logger from '../utils/logger.js';
import { GoogleAdapter }  from '../adapters/google-adapter.js';
import { ZohoAdapter }    from '../adapters/zoho-adapter.js';
import { ADAdapter }      from '../adapters/ad-adapter.js';
import { BaseAdapter } from '../adapters/base-adapter.js';
import type { AdapterResult } from '../adapters/base-adapter.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface OutboxRow {
  id:           number;
  emp_id:       string;
  system:       string;
  op:           string;
  payload:      Record<string, unknown>;
  priority:     'HIGH' | 'NORMAL';
  attempts:     number;
  max_attempts: number;
}

// ---------------------------------------------------------------------------
// Redis + Adapter Registry
// ---------------------------------------------------------------------------
const redis = new Redis(config.redis.url, { lazyConnect: true, maxRetriesPerRequest: 3 });

const adapterRegistry: Record<string, BaseAdapter> = {
  GOOGLE: new GoogleAdapter(redis, config.google.saKeyJson),
  ZOHO:   new ZohoAdapter(redis, config.zoho.clientId, config.zoho.clientSecret, config.zoho.scimBaseUrl),
  AD:     new ADAdapter(redis, config.ad.url, config.ad.bindDn, config.ad.bindPassword, config.ad.baseDn),
};

// ---------------------------------------------------------------------------
// Leader election
// ---------------------------------------------------------------------------
const LEADER_KEY = 'idp:outbox:leader';
let leaderToken: string | null = null;
let leaderInterval: ReturnType<typeof setInterval> | null = null;
let drainInterval:  ReturnType<typeof setInterval> | null = null;
let running = false;

async function acquireLeadership(): Promise<boolean> {
  const token = `${process.pid}:${Date.now()}`;
  const result = await redis.set(LEADER_KEY, token, 'PX', config.app.outboxLeaderTtlMs, 'NX');
  if (result === 'OK') {
    leaderToken = token;
    logger.info({ token }, 'Outbox: leader election won');
    return true;
  }
  return false;
}

async function refreshLeadership(): Promise<void> {
  if (!leaderToken) return;

  // Extend TTL only if we still own the lock (Lua for atomicity)
  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("pexpire", KEYS[1], ARGV[2])
    else
      return 0
    end
  `;
  const result = await redis.eval(script, 1, LEADER_KEY, leaderToken, String(config.app.outboxLeaderTtlMs)) as number;
  if (result === 0) {
    leaderToken = null;
    logger.warn('Outbox: lost leadership — another node stole the lock');
  }
}

// ---------------------------------------------------------------------------
// Per-system concurrency semaphore
// ---------------------------------------------------------------------------
const MAX_CONCURRENT_PER_SYSTEM = 5;
const SEM_TTL_MS = 30_000;

async function acquireSemaphore(system: string): Promise<boolean> {
  const key   = `idp:outbox:sem:${system}`;
  const count = await redis.incr(key);
  await redis.pexpire(key, SEM_TTL_MS);
  if (count > MAX_CONCURRENT_PER_SYSTEM) {
    await redis.decr(key);
    return false;
  }
  return true;
}

async function releaseSemaphore(system: string): Promise<void> {
  const key = `idp:outbox:sem:${system}`;
  const val = await redis.decr(key);
  if (val < 0) await redis.set(key, 0, 'PX', SEM_TTL_MS); // guard against underflow
}

// ---------------------------------------------------------------------------
// Dispatch a single outbox row to the correct adapter
// ---------------------------------------------------------------------------
async function dispatch(row: OutboxRow): Promise<void> {
  const adapter = adapterRegistry[row.system];
  if (!adapter) {
    throw new Error(`No adapter registered for system: ${row.system}`);
  }

  const externalId = (row.payload['externalId'] as string | undefined) ?? '';
  if (!externalId) {
    throw new Error(`Outbox row ${row.id} is missing externalId in payload`);
  }

  let result: AdapterResult<unknown>;

  switch (row.op) {
    case 'DISABLE':
      result = await adapter.disable(externalId, row.payload);
      break;
    case 'ENABLE':
      result = await adapter.enable(externalId);
      break;
    case 'DELETE':
      result = await adapter.delete(externalId);
      break;
    case 'REVOKE_TOKENS':
      result = await adapter.revokeTokens(externalId);
      break;
    case 'REVOKE_BINDINGS':
      result = await adapter.revokeBindings(externalId);
      break;
    case 'LIST_BINDINGS':
      result = await adapter.listBindings(externalId);
      break;
    case 'CREATE_USER':
      result = { success: true, data: undefined };
      break;
    case 'WRITEBACK_PASSWORD':
      result = { success: true, data: undefined };
      break;
    default:
      throw new Error(`Unhandled op: ${row.op}`);
  }

  if (!result.success) {
    const retryable = result.retryable;
    const error = new Error(result.error);
    (error as unknown as Record<string, boolean>)['retryable'] = retryable;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Drain a batch of outbox rows
// ---------------------------------------------------------------------------
async function drainBatch(): Promise<void> {
  if (!leaderToken) return; // not the leader

  let rows: OutboxRow[];
  try {
    rows = await query<OutboxRow>(
      `SELECT id, emp_id, \`system\`, op, payload, priority, attempts, max_attempts
         FROM adapter_outbox
        WHERE status = 'PENDING'
          AND next_run_at <= UTC_TIMESTAMP()
        ORDER BY priority = 'HIGH' DESC, next_run_at ASC
        LIMIT 50
        FOR UPDATE SKIP LOCKED`,
      [],
    );
  } catch (err) {
    logger.error({ err }, 'Outbox: failed to fetch batch');
    return;
  }

  if (rows.length === 0) return;

  logger.debug({ count: rows.length }, 'Outbox: draining batch');

  // Mark as PROCESSING
  const ids = rows.map((r) => r.id);
  await query(
    `UPDATE adapter_outbox SET status = 'PROCESSING' WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids,
  );

  // Process each row with semaphore
  await Promise.all(rows.map(async (row) => {
    const sem = await acquireSemaphore(row.system);
    if (!sem) {
      // Release PROCESSING back to PENDING so it can be picked up next cycle
      await query(
        `UPDATE adapter_outbox SET status = 'PENDING' WHERE id = ?`,
        [row.id],
      );
      return;
    }

    try {
      await dispatch(row);

      await query(
        `UPDATE adapter_outbox
            SET status = 'DONE', last_error = NULL
          WHERE id = ?`,
        [row.id],
      );

      logger.info({ id: row.id, system: row.system, op: row.op, empId: row.emp_id }, 'Outbox: row completed');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable = (err instanceof Error && (err as unknown as Record<string, boolean>)['retryable'] !== false);
      const nextAttempts = row.attempts + 1;

      if (!retryable || nextAttempts >= row.max_attempts) {
        await query(
          `UPDATE adapter_outbox
              SET status = 'DEAD', attempts = ?, last_error = ?
            WHERE id = ?`,
          [nextAttempts, message, row.id],
        );
        logger.error({ id: row.id, system: row.system, op: row.op, empId: row.emp_id, attempts: nextAttempts, error: message }, 'Outbox: row dead-lettered');
      } else {
        // Exponential back-off: 2^attempts * 10s, capped at 1h
        const backoffSec = Math.min(10 * Math.pow(2, nextAttempts), 3600);
        await query(
          `UPDATE adapter_outbox
              SET status = 'PENDING',
                  attempts = ?,
                  last_error = ?,
                  next_run_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND)
            WHERE id = ?`,
          [nextAttempts, message, backoffSec, row.id],
        );
        logger.warn({ id: row.id, system: row.system, op: row.op, attempts: nextAttempts, backoffSec, error: message }, 'Outbox: row rescheduled');
      }
    } finally {
      await releaseSemaphore(row.system);
    }
  }));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
export async function start(): Promise<void> {
  await redis.connect();
  running = true;

  // Try to become leader; if not, retry on next poll cycle
  const isLeader = await acquireLeadership();
  if (!isLeader) {
    logger.info('Outbox: not leader, will poll for leadership');
  }

  // Refresh leadership every LEADER_TTL / 3
  const refreshMs = Math.floor(config.app.outboxLeaderTtlMs / 3);
  leaderInterval = setInterval(async () => {
    if (leaderToken) {
      await refreshLeadership();
    } else {
      // Try to win leadership if current holder dropped
      await acquireLeadership();
    }
  }, refreshMs);

  // Main drain loop
  drainInterval = setInterval(async () => {
    if (!running) return;
    try {
      await drainBatch();
    } catch (err) {
      logger.error({ err }, 'Outbox: unhandled error in drainBatch');
    }
  }, config.app.outboxPollIntervalMs);

  logger.info({ pollIntervalMs: config.app.outboxPollIntervalMs }, 'Outbox worker started');
}

export async function stop(): Promise<void> {
  running = false;
  if (leaderInterval) clearInterval(leaderInterval);
  if (drainInterval)  clearInterval(drainInterval);

  // Release leadership
  if (leaderToken) {
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await redis.eval(script, 1, LEADER_KEY, leaderToken);
    leaderToken = null;
  }

  await redis.quit();
  await pool.end();
  logger.info('Outbox worker stopped');
}

// ---------------------------------------------------------------------------
// Entrypoint when run as a standalone process (node dist/services/outbox-worker.js)
// ---------------------------------------------------------------------------
const isWorkerMain = process.argv[1]?.includes('outbox-worker');
if (isWorkerMain) {
  start().catch((err) => {
    logger.error({ err }, 'Outbox worker failed to start');
    process.exit(1);
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Outbox worker received shutdown signal');
    await stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT',  () => { void shutdown('SIGINT'); });
}
