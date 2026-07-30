const mockSet = jest.fn();

jest.mock('../auth/session-store', () => ({
  redis: { set: (...args: unknown[]) => mockSet(...args) },
}));

jest.mock('./logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import { withSchedLock } from './sched-lock';
import logger from './logger';

describe('withSchedLock', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('runs fn when the lock is acquired', async () => {
    mockSet.mockResolvedValue('OK');
    const fn = jest.fn().mockResolvedValue(undefined);

    await withSchedLock('attendance-iga', 55_000, fn);

    expect(mockSet).toHaveBeenCalledWith(
      'idp:sched:attendance-iga:lock',
      expect.stringMatching(/^.+:\d+$/),
      'PX',
      55_000,
      'NX',
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not run fn when another pod holds the lock', async () => {
    mockSet.mockResolvedValue(null);
    const fn = jest.fn().mockResolvedValue(undefined);

    await withSchedLock('access-request-expiry', 270_000, fn);

    expect(fn).not.toHaveBeenCalled();
  });

  it('fails open and runs fn when Redis is down', async () => {
    mockSet.mockRejectedValue(new Error('Redis unavailable'));
    const fn = jest.fn().mockResolvedValue(undefined);

    await withSchedLock('connector-health', 1000, fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'connector-health' }),
      expect.stringContaining('Redis unavailable'),
    );
  });
});
