/**
 * Redis-backed rate limiter for /auth endpoints — cluster-safe across pods.
 * Falls open (allows the request) if Redis is unreachable: an IdP hard-down
 * because the rate limiter can't reach Redis is worse than one unthrottled window.
 */
import { Request, Response, NextFunction } from 'express';
import { redis } from './session-store.js';
import logger from '../utils/logger.js';

// Atomic INCR + set-expiry-on-first-hit
const LUA = `
  local c = redis.call('INCR', KEYS[1])
  if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
  local ttl = redis.call('PTTL', KEYS[1])
  return {c, ttl}
`;

export function rateLimit(opts: { max: number; windowMs: number; keyFn?: (req: Request) => string }) {
  const { max, windowMs } = opts;
  const keyFn = opts.keyFn ?? ((req: Request) => req.ip ?? 'unknown');

  return (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      const key = `idp:rl:${keyFn(req)}`;
      try {
        const [count, pttl] = (await redis.eval(LUA, 1, key, String(windowMs))) as [number, number];
        if (count > max) {
          const retry = Math.max(1, Math.ceil(pttl / 1000));
          res.set('Retry-After', String(retry));
          res.status(429).json({ error: 'Too many requests', retryAfter: retry });
          return;
        }
        next();
      } catch (err) {
        logger.warn({ err }, 'Rate limiter Redis error — failing open');
        next();
      }
    })();
  };
}
