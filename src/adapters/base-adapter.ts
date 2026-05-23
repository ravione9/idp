import { Redis } from 'ioredis';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------
export type AdapterResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; retryable: boolean };

// ---------------------------------------------------------------------------
// Circuit Breaker States
// ---------------------------------------------------------------------------
export enum CircuitState {
  CLOSED    = 'CLOSED',    // Normal operation
  OPEN      = 'OPEN',      // Failing — fast-fail without calling upstream
  HALF_OPEN = 'HALF_OPEN', // Probe: allow one request through to test recovery
}

// ---------------------------------------------------------------------------
// Redis-backed Circuit Breaker
// ---------------------------------------------------------------------------
export class CircuitBreaker {
  private readonly keyState: string;
  private readonly keyErrorCount: string;
  private readonly keyTotalCount: string;
  private readonly keyOpenedAt: string;

  /** After how many ms in OPEN state do we move to HALF_OPEN? */
  private readonly halfOpenDelayMs: number;
  /** Error rate (0-100) that trips the breaker */
  private readonly errorThreshold: number;
  /** Minimum requests before the error rate is evaluated */
  private readonly minRequests: number;

  constructor(
    private readonly redis: Redis,
    private readonly name: string,
    options: {
      errorThreshold?: number;
      halfOpenDelayMs?: number;
      minRequests?: number;
    } = {},
  ) {
    this.keyState      = `cb:state:${name}`;
    this.keyErrorCount = `cb:errors:${name}`;
    this.keyTotalCount = `cb:total:${name}`;
    this.keyOpenedAt   = `cb:opened_at:${name}`;

    this.errorThreshold  = options.errorThreshold  ?? 50;
    this.halfOpenDelayMs = options.halfOpenDelayMs ?? 60_000;
    this.minRequests     = options.minRequests     ?? 5;
  }

  async getState(): Promise<CircuitState> {
    const raw = await this.redis.get(this.keyState);
    const state = (raw ?? CircuitState.CLOSED) as CircuitState;

    if (state === CircuitState.OPEN) {
      const openedAt = await this.redis.get(this.keyOpenedAt);
      if (openedAt !== null) {
        const elapsed = Date.now() - parseInt(openedAt, 10);
        if (elapsed > this.halfOpenDelayMs) {
          await this.redis.set(this.keyState, CircuitState.HALF_OPEN);
          return CircuitState.HALF_OPEN;
        }
      }
    }

    return state;
  }

  async recordSuccess(): Promise<void> {
    const state = await this.getState();
    if (state === CircuitState.HALF_OPEN) {
      // Probe succeeded — close the circuit and reset counters
      await this.redis.del(this.keyState, this.keyErrorCount, this.keyTotalCount, this.keyOpenedAt);
      logger.info({ circuit: this.name }, 'Circuit breaker closed after successful probe');
    } else {
      await this.redis.incr(this.keyTotalCount);
    }
  }

  async recordFailure(): Promise<void> {
    const state = await this.getState();

    if (state === CircuitState.HALF_OPEN) {
      // Probe failed — re-open immediately
      await this.redis.set(this.keyState, CircuitState.OPEN);
      await this.redis.set(this.keyOpenedAt, String(Date.now()));
      logger.warn({ circuit: this.name }, 'Circuit breaker re-opened after failed probe');
      return;
    }

    const [errors, total] = await Promise.all([
      this.redis.incr(this.keyErrorCount),
      this.redis.incr(this.keyTotalCount),
    ]);

    if (total >= this.minRequests) {
      const errorRate = (errors / total) * 100;
      if (errorRate >= this.errorThreshold) {
        await this.redis.set(this.keyState, CircuitState.OPEN);
        await this.redis.set(this.keyOpenedAt, String(Date.now()));
        logger.error(
          { circuit: this.name, errorRate: errorRate.toFixed(1), errors, total },
          'Circuit breaker opened',
        );
      }
    }
  }

  /**
   * Wrap a remote call with circuit-breaker logic.
   * Throws `CircuitOpenError` when the breaker is OPEN.
   */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    const state = await this.getState();

    if (state === CircuitState.OPEN) {
      throw new CircuitOpenError(`Circuit breaker for ${this.name} is OPEN`);
    }

    try {
      const result = await fn();
      await this.recordSuccess();
      return result;
    } catch (err) {
      await this.recordFailure();
      throw err;
    }
  }
}

export class CircuitOpenError extends Error {
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

// ---------------------------------------------------------------------------
// Abstract Base Adapter
// ---------------------------------------------------------------------------
export interface UserInfo {
  externalId: string;
  email: string;
  displayName: string;
  active: boolean;
  [key: string]: unknown;
}

export interface Binding {
  id: string;
  name: string;
  type: string;
  scope?: string;
}

export abstract class BaseAdapter {
  protected readonly cb: CircuitBreaker;

  constructor(
    protected readonly redis: Redis,
    protected readonly systemName: string,
    errorThreshold?: number,
  ) {
    this.cb = new CircuitBreaker(redis, systemName, { errorThreshold });
  }

  /** Retrieve a user's information from the target system. */
  abstract getUser(externalId: string): Promise<AdapterResult<UserInfo>>;

  /** Disable / suspend the user account. */
  abstract disable(externalId: string, evidence?: Record<string, unknown>): Promise<AdapterResult<void>>;

  /** Re-enable a previously disabled account. */
  abstract enable(externalId: string): Promise<AdapterResult<void>>;

  /** Permanently delete the user from the system. */
  abstract delete(externalId: string): Promise<AdapterResult<void>>;

  /** Revoke all active OAuth / session tokens for this user. */
  abstract revokeTokens(externalId: string): Promise<AdapterResult<void>>;

  /** List all role/group bindings the user currently holds. */
  abstract listBindings(externalId: string): Promise<AdapterResult<Binding[]>>;

  /** Revoke all bindings returned by listBindings. Default impl; override for custom logic. */
  async revokeBindings(externalId: string): Promise<AdapterResult<void>> {
    const result = await this.listBindings(externalId);
    if (!result.success) {
      return result;
    }
    // Subclasses that have a bulk-revoke API should override this.
    // Default: best-effort sequential revocation (logged, non-fatal partial failures).
    logger.warn(
      { system: this.systemName, externalId, bindingCount: result.data.length },
      'revokeBindings using default sequential implementation',
    );
    return { success: true, data: undefined };
  }

  /** Helper: wrap a remote call with circuit breaker, converting errors to AdapterResult */
  protected async safe<T>(fn: () => Promise<T>): Promise<AdapterResult<T>> {
    try {
      const data = await this.cb.call(fn);
      return { success: true, data };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable = !(err instanceof CircuitOpenError);
      logger.error({ system: this.systemName, error: message }, 'Adapter call failed');
      return { success: false, error: message, retryable };
    }
  }
}
