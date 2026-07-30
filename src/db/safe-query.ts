/**
 * Defensive wrappers around the DB layer so that endpoints can degrade
 * gracefully when a feature table is missing (e.g., a migration hasn't been
 * applied yet on a long-lived volume). This avoids cascading 500s in the UI.
 *
 * When `ER_NO_SUCH_TABLE` is raised, the helper returns the supplied fallback
 * value and logs a warning. Every other error is rethrown so real bugs are
 * still visible.
 */
import { query } from './connection.js';
import logger from '../utils/logger.js';

interface MysqlError extends Error {
  code?: string;
  errno?: number;
  sqlMessage?: string;
}

const TABLE_MISSING_CODES = new Set(['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR']);

export async function safeQuery<T>(sql: string, params: unknown[], fallback: T[] = []): Promise<T[]> {
  try {
    return await query<T>(sql, params);
  } catch (err) {
    const e = err as MysqlError;
    if (e.code && TABLE_MISSING_CODES.has(e.code)) {
      logger.warn(
        { code: e.code, message: e.sqlMessage ?? e.message },
        'safeQuery: schema not yet ready — returning fallback',
      );
      return fallback;
    }
    throw err;
  }
}

export async function safeCount(sql: string, params: unknown[]): Promise<number> {
  const rows = await safeQuery<{ n: number }>(sql, params);
  return rows[0]?.n ?? 0;
}
