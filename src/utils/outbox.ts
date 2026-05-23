/**
 * LILG Outbox Utilities
 * ----------------------
 * Helpers for enqueuing adapter outbox operations and querying identity links.
 */

import { query } from '../db/connection.js';
import type { PoolConnection } from 'mysql2/promise';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface OutboxEntry {
  system:    string;
  op:        string;
  payload?:  Record<string, unknown>;
  priority?: 'HIGH' | 'NORMAL';
}

export interface IdentityLink {
  id:          number;
  emp_id:      string;
  system:      string;
  external_id: string;
  status:      'ACTIVE' | 'DISABLED' | 'DELETED' | 'ORPHAN';
  auth_kind:   string;
}

// ---------------------------------------------------------------------------
// getIdentityLinksForEmp
// Returns all non-deleted identity links for an employee.
// ---------------------------------------------------------------------------
export async function getIdentityLinksForEmp(
  empId: string,
  conn?: PoolConnection,
): Promise<IdentityLink[]> {
  return query<IdentityLink>(
    `SELECT id, emp_id, system, external_id, status, auth_kind
       FROM identity_links
      WHERE emp_id = ?
        AND status IN ('ACTIVE', 'DISABLED')
      ORDER BY system ASC`,
    [empId],
    conn,
  );
}

// ---------------------------------------------------------------------------
// enqueueOutboxOps
// Batch-inserts outbox rows. Uses INSERT IGNORE to skip duplicates on
// (emp_id, system, op) that are still PENDING (idempotent re-trigger).
// ---------------------------------------------------------------------------
export async function enqueueOutboxOps(
  empId:   string,
  entries: OutboxEntry[],
  conn?:   PoolConnection,
): Promise<void> {
  if (entries.length === 0) return;

  const values: unknown[] = [];
  const placeholders: string[] = [];

  for (const entry of entries) {
    placeholders.push('(?, ?, ?, ?, ?, UTC_TIMESTAMP())');
    values.push(
      empId,
      entry.system,
      entry.op,
      JSON.stringify(entry.payload ?? {}),
      entry.priority ?? 'NORMAL',
    );
  }

  await query(
    `INSERT INTO adapter_outbox (emp_id, system, op, payload, priority, next_run_at)
     VALUES ${placeholders.join(', ')}`,
    values,
    conn,
  );
}

// ---------------------------------------------------------------------------
// getOutboxQueueDepth
// Returns queue depth by status for metrics / backpressure checks.
// ---------------------------------------------------------------------------
export async function getOutboxQueueDepth(): Promise<Record<string, number>> {
  const rows = await query<{ status: string; count: number }>(
    `SELECT status, COUNT(*) AS count FROM adapter_outbox GROUP BY status`,
    [],
  );

  const depth: Record<string, number> = {
    PENDING:    0,
    PROCESSING: 0,
    DONE:       0,
    DEAD:       0,
  };

  for (const row of rows) {
    depth[row.status] = row.count;
  }

  return depth;
}
