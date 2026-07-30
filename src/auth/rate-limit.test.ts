import type { Request, Response, NextFunction } from 'express';

const mockEval = jest.fn();

jest.mock('./session-store', () => ({
  redis: { eval: (...args: unknown[]) => mockEval(...args) },
}));

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import { rateLimit } from './rate-limit';
import logger from '../utils/logger';

function mockRes(): Response {
  const res = {
    set: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res as unknown as Response;
}

describe('rateLimit (Redis fixed-window)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('allows the request when count <= max', async () => {
    mockEval.mockResolvedValue([3, 45_000]);
    const mw = rateLimit({ max: 10, windowMs: 60_000 });
    const req = { ip: '1.2.3.4' } as Request;
    const res = mockRes();
    const next = jest.fn() as NextFunction;

    mw(req, res, next);
    await new Promise((r) => setImmediate(r));

    expect(mockEval).toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 429 with Retry-After when count > max', async () => {
    mockEval.mockResolvedValue([11, 30_000]);
    const mw = rateLimit({ max: 10, windowMs: 60_000, keyFn: () => 'user@ex.com' });
    const req = {} as Request;
    const res = mockRes();
    const next = jest.fn() as NextFunction;

    mw(req, res, next);
    await new Promise((r) => setImmediate(r));

    expect(next).not.toHaveBeenCalled();
    expect(res.set).toHaveBeenCalledWith('Retry-After', '30');
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith({ error: 'Too many requests', retryAfter: 30 });
  });

  it('fails open (allows request) when Redis errors', async () => {
    mockEval.mockRejectedValue(new Error('ECONNREFUSED'));
    const mw = rateLimit({ max: 10, windowMs: 60_000 });
    const req = { ip: '9.9.9.9' } as Request;
    const res = mockRes();
    const next = jest.fn() as NextFunction;

    mw(req, res, next);
    await new Promise((r) => setImmediate(r));

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('fails open when Redis is slow (timeout)', async () => {
    mockEval.mockImplementation(() => new Promise(() => { /* never resolves */ }));
    const mw = rateLimit({ max: 10, windowMs: 60_000 });
    const req = { ip: '8.8.8.8' } as Request;
    const res = mockRes();
    const next = jest.fn() as NextFunction;

    mw(req, res, next);
    await new Promise((r) => setTimeout(r, 350));

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});
