/**
 * Express 4 async handler wrapper.
 *
 * Express 4 does NOT auto-catch async errors thrown in route handlers — a
 * rejected promise becomes an unhandledRejection. This wrapper forwards any
 * thrown error to next(err) so it reaches the global error middleware and
 * the client gets a proper 500 instead of a crashed process.
 *
 * Use as:
 *   router.get('/path', asyncHandler(async (req, res) => { ... }));
 *
 * Or wrap a list of middlewares:
 *   router.get('/path', requireRole('ADMIN'), asyncHandler(async (req, res) => { ... }));
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';

export type AsyncRequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<unknown> | unknown;

export function asyncHandler(fn: AsyncRequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
