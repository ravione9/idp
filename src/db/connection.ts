/**
 * LILG — MySQL2 Connection Pool
 * ------------------------------
 * Exports:
 *   pool         — raw mysql2 Pool (for draining at shutdown)
 *   query<T>     — type-safe query returning T[]
 *   queryOne<T>  — returns T | null
 *   transaction  — wraps a callback in BEGIN/COMMIT/ROLLBACK
 */

import mysql, { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
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
 */
export async function query<T>(
  sql:    string,
  params: unknown[],
  conn?:  PoolConnection,
): Promise<T[]> {
  const executor = conn ?? pool;
  try {
    const [rows] = await executor.execute(sql, params);
    return rows as unknown as T[];
  } catch (err) {
    logger.error({ sql, err }, 'DB query failed');
    throw err;
  }
}

/**
 * Execute a DML statement (INSERT / UPDATE / DELETE) and return the
 * ResultSetHeader (affectedRows, insertId, etc.).
 */
export async function execute(
  sql:    string,
  params: unknown[],
  conn?:  PoolConnection,
): Promise<ResultSetHeader> {
  const executor = conn ?? pool;
  try {
    const [header] = await executor.execute<ResultSetHeader>(sql, params);
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
