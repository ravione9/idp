/**
 * LILG Audit Log
 * --------------
 * Tamper-evident hash chain. Each row stores:
 *   - The SHA-256 of (prev_hash + canonical JSON of payload)
 * Any post-hoc modification of a row breaks the chain.
 *
 * Concurrent writes are serialized with MySQL advisory lock
 * GET_LOCK('audit_log_writer', 10).
 */

import crypto from 'crypto';
import { query, queryOne } from '../db/connection.js';
import type { PoolConnection } from 'mysql2/promise';
import logger from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface AuditRow {
  id:        number;
  curr_hash: string;
  prev_hash: string | null;
  actor:     string;
  action:    string;
  target:    string;
  payload:   unknown;
  ts:        string;
}

// ---------------------------------------------------------------------------
// Compute hash for a row
// ---------------------------------------------------------------------------
function computeHash(prevHash: string | null, actor: string, action: string, target: string, payload: unknown): string {
  const canonical = JSON.stringify({
    prevHash: prevHash ?? '',
    actor,
    action,
    target,
    payload: sortedJsonObject(payload),
  });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Return a deeply sorted-key representation of an object so that key ordering
 * does not affect the hash.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sortedJsonObject(obj: unknown): any {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sortedJsonObject);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = sortedJsonObject((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

// ---------------------------------------------------------------------------
// appendAuditLog
// ---------------------------------------------------------------------------
export async function appendAuditLog(
  actor:   string,
  action:  string,
  target:  string,
  payload: Record<string, unknown>,
  conn?:   PoolConnection,
): Promise<void> {
  const advisoryLock = 'audit_log_writer';

  const doInsert = async (c: PoolConnection | undefined) => {
    // Acquire advisory lock to serialize concurrent writers
    const lockResult = await queryOne<{ locked: number }>(
      `SELECT GET_LOCK(?, 10) AS locked`,
      [advisoryLock],
      c,
    );

    if (!lockResult || !lockResult.locked) {
      throw new Error('Failed to acquire audit_log advisory lock after 10 seconds');
    }

    try {
      // Read the last row's hash
      const lastRow = await queryOne<{ id: number; curr_hash: string }>(
        `SELECT id, curr_hash FROM audit_log ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [],
        c,
      );

      const prevHash = lastRow?.curr_hash ?? null;
      const currHash = computeHash(prevHash, actor, action, target, payload);

      await query(
        `INSERT INTO audit_log (actor, action, target, payload, prev_hash, curr_hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [actor, action, target, JSON.stringify(payload), prevHash, currHash],
        c,
      );
    } finally {
      // Always release the advisory lock
      await queryOne(`SELECT RELEASE_LOCK(?)`, [advisoryLock], c).catch(() => {/* ignore */});
    }
  };

  await doInsert(conn);
}

// ---------------------------------------------------------------------------
// verifyChain — reads the last N rows and recomputes their hash chain
// ---------------------------------------------------------------------------
export async function verifyChain(limit = 1000): Promise<{
  valid:          boolean;
  firstInvalidId: number | null;
  checked:        number;
}> {
  const rows = await query<AuditRow>(
    `SELECT id, curr_hash, prev_hash, actor, action, target, payload, ts
       FROM audit_log
      ORDER BY id ASC
      LIMIT ?`,
    [limit],
  );

  let firstInvalidId: number | null = null;
  let prevHash: string | null = null;

  for (const row of rows) {
    const expected = computeHash(prevHash, row.actor, row.action, row.target, row.payload);

    if (expected !== row.curr_hash) {
      logger.error(
        { id: row.id, expected, got: row.curr_hash },
        'Audit chain integrity violation detected',
      );
      firstInvalidId = row.id;
      break;
    }

    // Cross-check prev_hash linkage
    if (row.prev_hash !== prevHash) {
      logger.error(
        { id: row.id, expectedPrev: prevHash, gotPrev: row.prev_hash },
        'Audit chain prev_hash mismatch',
      );
      firstInvalidId = row.id;
      break;
    }

    prevHash = row.curr_hash;
  }

  return {
    valid:          firstInvalidId === null,
    firstInvalidId,
    checked:        rows.length,
  };
}
