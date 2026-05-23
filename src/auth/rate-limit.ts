/**
 * Tiny in-process rate limiter for /auth endpoints.
 * Uses a sliding window keyed by IP+email.
 *
 * For multi-instance deployments later, replace with Redis-backed counters.
 */
import { Request, Response, NextFunction } from 'express';

interface Bucket {
  count: number;
  reset: number;
}

const buckets = new Map<string, Bucket>();

function evict(): void {
  const now = Date.now();
  for (const [key, b] of buckets) {
    if (b.reset <= now) buckets.delete(key);
  }
}

setInterval(evict, 60_000).unref();

export function rateLimit(opts: { max: number; windowMs: number; keyFn?: (req: Request) => string }) {
  const { max, windowMs } = opts;
  const keyFn = opts.keyFn ?? ((req: Request) => req.ip ?? 'unknown');

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = keyFn(req);
    const now = Date.now();
    const existing = buckets.get(key);

    if (!existing || existing.reset <= now) {
      buckets.set(key, { count: 1, reset: now + windowMs });
      next();
      return;
    }

    if (existing.count >= max) {
      const retry = Math.ceil((existing.reset - now) / 1000);
      res.set('Retry-After', String(retry));
      res.status(429).json({
        error:      'Too many requests',
        retryAfter: retry,
      });
      return;
    }

    existing.count += 1;
    next();
  };
}
