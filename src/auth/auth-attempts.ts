/**
 * Shared Login Attempts logger (auth_attempts table).
 */
import { query } from '../db/connection.js';
import logger from '../utils/logger.js';

export async function logAuthAttempt(
  email: string,
  ip: string,
  success: boolean,
  reason?: string,
): Promise<void> {
  try {
    await query(
      `INSERT INTO auth_attempts (email, ip, success, reason) VALUES (?, ?, ?, ?)`,
      [email, ip || null, success ? 1 : 0, reason ?? null],
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to log auth attempt');
  }
}
