/**
 * Shared Redis client for the auth layer.
 * Exported separately to avoid circular imports.
 */
import { Redis } from 'ioredis';
import { config } from '../config.js';

export const redis = new Redis(config.redis.url, {
  lazyConnect:          true,
  maxRetriesPerRequest: 1,
  enableReadyCheck:     true,
  /** Fail fast — auth must not hang when Redis is down or reconnecting. */
  connectTimeout:       2_000,
  commandTimeout:       2_000,
});
