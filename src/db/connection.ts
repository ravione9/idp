/**
 * LILG — MySQL2 Connection Pool
 * ------------------------------
 * Exports:
 *   pool         — raw mysql2 Pool (for draining at shutdown)
 *   query<T>     — type-safe query returning T[]
 *   queryOne<T>  — returns T | null
 *   transaction  — wraps a callback in BEGIN/COMMIT/ROLLBACK
 */

import mysql, { Pool, PoolConnection, ResultSetHeader } from 'mysql2/promise';
import type { ExecuteValues } from 'mysql2';
import { config } from '../config.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Pool creation
// ---------------------------------------------------------------------------
export const pool: Pool = mysql.createPool({
  host:              config.db.host,
  port:              config.db.port,
  user:              config.db.user,
  password:          config.db.password,
  database:          config.db.database,
  waitForConnections: true,
  connectionLimit:   20,
  queueLimit:        100,
  enableKeepAlive:   true,
  keepAliveInitialDelay: 10_000,
  timezone:          '+00:00',
  charset:           'utf8mb4',
  // Reconnect on gone-away / lost connection errors
  multipleStatements: false,
  connectTimeout:    10_000,
});

// ---------------------------------------------------------------------------
// Reconnect on pool-level errors
// ---------------------------------------------------------------------------
pool.on('connection', (conn) => {
  logger.debug({ threadId: conn.threadId }, 'DB: new pool connection established');
});

// ---------------------------------------------------------------------------
// Type-safe query helper
// ---------------------------------------------------------------------------

/**
 * Execute a SELECT-style query and return typed rows.
 * Accepts an optional connection for use inside transactions.
 *
 * Uses pool.query() (NOT pool.execute()): mysql2's prepared-statement
 * protocol on MySQL 8 rejects integer parameters in `LIMIT ? OFFSET ?`
 * with ER_WRONG_ARGUMENTS (errno 1210). pool.query() escapes values
 * inline as text, which works correctly with LIMIT/OFFSET and is still
 * SQL-injection-safe because mysql2 escapes every placeholder value.
 */
export async function query<T>(
  sql:    string,
  params: unknown[],
  conn?:  PoolConnection,
): Promise<T[]> {
  const executor = conn ?? pool;
  try {
    const [rows] = await executor.query(sql, params as ExecuteValues);
    return rows as unknown as T[];
  } catch (err) {
    logger.error({ sql, err }, 'DB query failed');
    throw err;
  }
}

/**
 * Execute a DML statement (INSERT / UPDATE / DELETE) and return the
 * ResultSetHeader (affectedRows, insertId, etc.).
 *
 * Also uses pool.query() to avoid the prepared-statement LIMIT/OFFSET
 * type-binding issue on MySQL 8 — see the comment on `query()` above.
 */
export async function execute(
  sql:    string,
  params: unknown[],
  conn?:  PoolConnection,
): Promise<ResultSetHeader> {
  const executor = conn ?? pool;
  try {
    const [header] = await executor.query<ResultSetHeader>(sql, params as ExecuteValues);
    return header;
  } catch (err) {
    logger.error({ sql, err }, 'DB execute failed');
    throw err;
  }
}

/**
 * Return the first matching row or null.
 */
export async function queryOne<T>(
  sql:    string,
  params: unknown[],
  conn?:  PoolConnection,
): Promise<T | null> {
  const rows = await query<T>(sql, params, conn);
  return rows.length > 0 ? (rows[0] as T) : null;
}

// ---------------------------------------------------------------------------
// Transaction helper
// ---------------------------------------------------------------------------

/**
 * Run `fn` inside a MySQL transaction.
 * BEGIN is sent before calling fn; COMMIT on success; ROLLBACK on any error.
 * The connection is always released back to the pool.
 */
export async function transaction<T>(
  fn: (conn: PoolConnection) => Promise<T>,
): Promise<T> {
  const conn = await pool.getConnection();
  await conn.beginTransaction();
  try {
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
export async function closePool(): Promise<void> {
  await pool.end();
  logger.info('DB: connection pool closed');
}
