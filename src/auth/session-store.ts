/**
 * Shared Redis client for the auth layer.
 * Exported separately to avoid circular imports.
 */
import { Redis } from 'ioredis';
import { config } from '../config.js';

export const redis = new Redis(config.redis.url, {
  lazyConnect:          true,
  maxRetriesPerRequest: 3,
  enableReadyCheck:     true,
});
