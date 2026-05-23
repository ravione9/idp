/**
 * LILG ABAC Policy Engine
 * -----------------------
 * Evaluates attribute-based access control policies stored in abac_policies.
 * Supports a CEL-like expression language subset.
 *
 * Expression syntax:
 *   - Literals:   "string", 42, true, false
 *   - Attribute:  subject.role, resource.empId, env.deviceManaged
 *   - Operators:  == != < > <= >= && || ! in
 *   - Examples:
 *       subject.role == "MANAGER" && resource.empId != subject.empId
 *       subject.role in ["ADMIN", "SUPER_ADMIN"]
 *       !env.deviceManaged && resource.classification == "SENSITIVE"
 */

import { Request, Response, NextFunction } from 'express';
import { query } from '../db/connection.js';
import { redis } from '../auth/session-store.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface PolicySubject {
  empId:         string;
  role:          string;
  email:         string;
  employmentType?: string;
  [key: string]: unknown;
}

export interface PolicyResource {
  type:          string;
  empId?:        string;
  classification?: string;
  [key: string]: unknown;
}

export interface PolicyEnv {
  deviceManaged?:  boolean;
  ip?:             string;
  hour?:           number;  // 0-23
  isWeekend?:      boolean;
  [key: string]: unknown;
}

export interface PolicyDecision {
  effect:    'ALLOW' | 'DENY';
  policyId?: number;
  policyName?: string;
}

interface PolicyRow {
  id:             number;
  name:           string;
  effect:         'ALLOW' | 'DENY';
  condition_expr: string;
  priority:       number;
}

// ---------------------------------------------------------------------------
// CEL-like expression evaluator
// ---------------------------------------------------------------------------
type Value = string | number | boolean | null | Value[];

export class SimpleExprEvaluator {
  private pos = 0;
  private src = '';

  evaluate(
    expr: string,
    context: Record<string, unknown>,
  ): boolean {
    this.src = expr.trim();
    this.pos = 0;
    const result = this.parseOr(context);
    return Boolean(result);
  }

  private parseOr(ctx: Record<string, unknown>): Value {
    let left = this.parseAnd(ctx);
    while (this.matchKeyword('||')) {
      const right = this.parseAnd(ctx);
      left = Boolean(left) || Boolean(right);
    }
    return left;
  }

  private parseAnd(ctx: Record<string, unknown>): Value {
    let left = this.parseUnary(ctx);
    while (this.matchKeyword('&&')) {
      const right = this.parseUnary(ctx);
      left = Boolean(left) && Boolean(right);
    }
    return left;
  }

  private parseUnary(ctx: Record<string, unknown>): Value {
    this.skipWhitespace();
    if (this.matchChar('!')) {
      return !Boolean(this.parseComparison(ctx));
    }
    return this.parseComparison(ctx);
  }

  private parseComparison(ctx: Record<string, unknown>): Value {
    const left = this.parsePrimary(ctx);
    this.skipWhitespace();

    // Check for 'in' operator
    if (this.matchKeyword('in')) {
      const right = this.parsePrimary(ctx);
      if (Array.isArray(right)) {
        return right.some((v) => v === left);
      }
      return false;
    }

    const ops = ['==', '!=', '<=', '>=', '<', '>'];
    for (const op of ops) {
      if (this.matchKeyword(op)) {
        const right = this.parsePrimary(ctx);
        switch (op) {
          case '==': return left === right;
          case '!=': return left !== right;
          case '<':  return (left as number)  <  (right as number);
          case '>':  return (left as number)  >  (right as number);
          case '<=': return (left as number)  <= (right as number);
          case '>=': return (left as number)  >= (right as number);
        }
      }
    }

    return left;
  }

  private parsePrimary(ctx: Record<string, unknown>): Value {
    this.skipWhitespace();

    // Array literal
    if (this.matchChar('[')) {
      const arr: Value[] = [];
      while (!this.matchChar(']')) {
        this.skipWhitespace();
        if (this.peek() === ']') break;
        arr.push(this.parsePrimary(ctx));
        this.skipWhitespace();
        this.matchChar(',');
      }
      return arr;
    }

    // String literal
    if (this.peek() === '"' || this.peek() === "'") {
      const quote = this.src[this.pos++];
      let str = '';
      while (this.pos < this.src.length && this.src[this.pos] !== quote) {
        if (this.src[this.pos] === '\\') this.pos++;
        str += this.src[this.pos++];
      }
      this.pos++; // closing quote
      return str;
    }

    // Number literal
    if (/\d/.test(this.peek())) {
      let num = '';
      while (/[\d.]/.test(this.peek())) num += this.src[this.pos++];
      return parseFloat(num);
    }

    // Boolean / null
    if (this.matchKeyword('true'))  return true;
    if (this.matchKeyword('false')) return false;
    if (this.matchKeyword('null'))  return null;

    // Grouped expression
    if (this.matchChar('(')) {
      const val = this.parseOr(ctx);
      this.skipWhitespace();
      this.matchChar(')');
      return val;
    }

    // Identifier / dot-path (e.g. subject.role)
    let ident = '';
    while (this.pos < this.src.length && /[\w.]/.test(this.src[this.pos])) {
      ident += this.src[this.pos++];
    }

    if (!ident) {
      throw new Error(`Unexpected character at pos ${this.pos}: ${this.src[this.pos]}`);
    }

    // Resolve dot-path in context
    return this.resolvePath(ident, ctx);
  }

  private resolvePath(path: string, ctx: Record<string, unknown>): Value {
    const parts = path.split('.');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cur: any = ctx;
    for (const part of parts) {
      if (cur === null || cur === undefined) return null;
      cur = cur[part];
    }
    if (cur === null || cur === undefined) return null;
    if (typeof cur === 'string' || typeof cur === 'number' || typeof cur === 'boolean') return cur;
    if (Array.isArray(cur)) return cur as Value[];
    return String(cur);
  }

  private peek(): string {
    this.skipWhitespace();
    return this.src[this.pos] ?? '';
  }

  private matchChar(c: string): boolean {
    this.skipWhitespace();
    if (this.src[this.pos] === c) { this.pos++; return true; }
    return false;
  }

  private matchKeyword(kw: string): boolean {
    this.skipWhitespace();
    if (this.src.startsWith(kw, this.pos)) {
      const after = this.src[this.pos + kw.length];
      // Ensure it's not part of a larger token (word boundary for alphanumeric kws)
      if (/\w/.test(kw[0]) && after && /\w/.test(after)) return false;
      this.pos += kw.length;
      return true;
    }
    return false;
  }

  private skipWhitespace(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos++;
  }
}

// ---------------------------------------------------------------------------
// PolicyEngine
// ---------------------------------------------------------------------------
const POLICY_CACHE_KEY = 'lilg:abac:policies';
const POLICY_CACHE_TTL = 60; // seconds

export class PolicyEngine {
  private readonly evaluator = new SimpleExprEvaluator();

  async loadPolicies(): Promise<PolicyRow[]> {
    const cached = await redis.get(POLICY_CACHE_KEY);
    if (cached) {
      return JSON.parse(cached) as PolicyRow[];
    }

    const rows = await query<PolicyRow>(
      `SELECT id, name, effect, condition_expr, priority
         FROM abac_policies
        WHERE active = 1
        ORDER BY priority ASC`,
      [],
    );

    await redis.set(POLICY_CACHE_KEY, JSON.stringify(rows), 'EX', POLICY_CACHE_TTL);
    return rows;
  }

  async evaluate(
    subject:  PolicySubject,
    resource: PolicyResource,
    action:   string,
    env:      PolicyEnv,
  ): Promise<PolicyDecision> {
    const policies = await this.loadPolicies();

    const context: Record<string, unknown> = {
      subject,
      resource,
      action,
      env,
    };

    for (const policy of policies) {
      try {
        const matches = this.evaluator.evaluate(policy.condition_expr, context);
        if (matches) {
          logger.debug(
            { policyId: policy.id, name: policy.name, effect: policy.effect, action },
            'ABAC policy matched',
          );
          return {
            effect:     policy.effect,
            policyId:   policy.id,
            policyName: policy.name,
          };
        }
      } catch (err) {
        logger.error({ policyId: policy.id, err }, 'ABAC policy expression evaluation error');
        // Skip malformed policies — do not treat error as DENY
      }
    }

    // Default: ALLOW for standard roles; DENY for privileged resource classes
    const sensitiveResource = resource.classification === 'SENSITIVE' || resource.classification === 'RESTRICTED';
    const privilegedRole    = ['ADMIN', 'SUPER_ADMIN'].includes(subject.role);

    if (sensitiveResource && !privilegedRole) {
      return { effect: 'DENY' };
    }

    return { effect: 'ALLOW' };
  }

  /**
   * Express middleware factory.
   * `resourceFn` extracts a PolicyResource from the request.
   */
  requireAbac(resourceFn: (req: Request) => PolicyResource) {
    return (req: Request, res: Response, next: NextFunction): void => {
      void (async () => {
        const user = req.user;
        if (!user) {
          res.status(401).json({ error: 'Unauthenticated' });
          return;
        }

        const subject: PolicySubject = {
          empId: user.empId,
          role:  user.role,
          email: user.email,
        };

        const resource = resourceFn(req);

        const env: PolicyEnv = {
          ip:          req.ip ?? undefined,
          hour:        new Date().getHours(),
          isWeekend:   [0, 6].includes(new Date().getDay()),
          deviceManaged: req.headers['x-device-managed'] === 'true',
        };

        const decision = await this.evaluate(subject, resource, req.method, env);

        if (decision.effect === 'DENY') {
          logger.warn(
            { empId: user.empId, action: req.method, resource, policyId: decision.policyId },
            'ABAC: access denied',
          );
          res.status(403).json({
            error:      'Access denied by policy',
            code:       'ABAC_DENY',
            policyId:   decision.policyId,
            policyName: decision.policyName,
          });
          return;
        }

        next();
      })();
    };
  }
}

export const policyEngine = new PolicyEngine();
