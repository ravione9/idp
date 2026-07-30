/**
 * Session idle / absolute TTL from General Settings (env fallback).
 * default_session_hours = idle / sliding window
 * session_absolute_hours = hard cap from login
 */
import { queryOne } from '../db/connection.js';
import { config } from '../config.js';
import logger from '../utils/logger.js';

export interface SessionPolicy {
  /** Idle timeout hours — session ends if no activity for this long. */
  idleHours: number;
  /** Absolute max hours from session creation. */
  absoluteHours: number;
  /** Initial cookie / expires_at TTL = min(idle, absolute). */
  createTtlHours: number;
}

const CACHE_MS = 30_000;
let cached: { at: number; policy: SessionPolicy } | null = null;

function clampHours(n: unknown, fallback: number): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v) || v < 1) return fallback;
  return Math.min(Math.floor(v), 24 * 30); // max 30 days
}

function buildPolicy(idleRaw: number, absoluteRaw: number): SessionPolicy {
  const envIdle = config.session.ttlCorporateHours;
  const idleHours = clampHours(idleRaw, envIdle);
  const absoluteHours = Math.max(clampHours(absoluteRaw, Math.max(idleHours, 24)), idleHours);
  return {
    idleHours,
    absoluteHours,
    createTtlHours: Math.min(idleHours, absoluteHours),
  };
}

export function invalidateSessionPolicyCache(): void {
  cached = null;
}

export async function getSessionPolicy(): Promise<SessionPolicy> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.policy;

  try {
    const row = await queryOne<{
      default_session_hours: number;
      session_absolute_hours: number;
    }>(
      `SELECT default_session_hours, session_absolute_hours
         FROM general_settings WHERE id = 1`,
      [],
    );
    const policy = buildPolicy(
      row?.default_session_hours ?? config.session.ttlCorporateHours,
      row?.session_absolute_hours ?? Math.max(config.session.ttlCorporateHours, 24),
    );
    cached = { at: Date.now(), policy };
    return policy;
  } catch (err) {
    logger.warn({ err }, 'Failed to load session policy; using env defaults');
    const policy = buildPolicy(
      config.session.ttlCorporateHours,
      Math.max(config.session.ttlCorporateHours, 24),
    );
    cached = { at: Date.now(), policy };
    return policy;
  }
}

/** Hours to use when issuing a new session cookie / expires_at. */
export async function getSessionCreateTtlHours(): Promise<number> {
  return (await getSessionPolicy()).createTtlHours;
}
