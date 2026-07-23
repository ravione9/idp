/**
 * Config — Birthright Rules API
 * Mounted at /api/admin/birthright
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../auth/middleware.js';
import { requireRole, requirePortalModule } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import { query, queryOne, execute } from '../db/connection.js';
import {
  dryRunBirthrightForEmployee,
  kickConnectorProvision,
  reconcileBirthrightForEmployee,
  summarizeRule,
  type BirthrightRule,
} from '../services/birthright.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('ADMIN', 'SUPER_ADMIN'), requirePortalModule('access_model'));

const ruleSchema = z.object({
  dept_ids: z.array(z.string()).optional(),
  employment_types: z.array(z.string()).optional(),
  roles: z.array(z.string()).optional(),
  group_ids: z.array(z.string()).optional(),
  exclude_dept_ids: z.array(z.string()).optional(),
  all_active: z.boolean().optional(),
}).passthrough();

const createSchema = z.object({
  name: z.string().min(1).max(150),
  slug: z.string().min(1).max(150).regex(/^[a-z0-9][a-z0-9_-]*$/i).optional(),
  description: z.string().max(2000).optional().nullable(),
  app_id: z.string().min(1).max(36).optional().nullable(),
  connector_id: z.string().min(1).max(36).optional().nullable(),
  type: z.enum(['ROLE', 'GROUP', 'PERMISSION', 'LICENSE', 'CAPABILITY']).optional().default('ROLE'),
  risk_score: z.number().int().min(0).max(100).optional().default(0),
  birthright_rule: ruleSchema.optional().nullable(),
  active: z.boolean().optional().default(true),
});

const updateSchema = z.object({
  name: z.string().min(1).max(150).optional(),
  description: z.string().max(2000).optional().nullable(),
  app_id: z.string().min(1).max(36).optional().nullable(),
  connector_id: z.string().min(1).max(36).optional().nullable(),
  type: z.enum(['ROLE', 'GROUP', 'PERMISSION', 'LICENSE', 'CAPABILITY']).optional(),
  risk_score: z.number().int().min(0).max(100).optional(),
  is_birthright: z.union([z.boolean(), z.number()]).optional(),
  birthright_rule: ruleSchema.optional().nullable(),
  active: z.union([z.boolean(), z.number()]).optional(),
});

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140) || `br-${Date.now().toString(36)}`;
}

function parseStoredRule(raw: unknown): BirthrightRule {
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as BirthrightRule; } catch { return {}; }
  }
  if (typeof raw === 'object') return raw as BirthrightRule;
  return {};
}

// GET / — list birthright entitlements
router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await query<Record<string, unknown>>(
    `SELECT ent.id, ent.app_id, ent.connector_id, ent.name, ent.slug, ent.type,
            ent.description, ent.risk_score, ent.is_birthright, ent.birthright_rule,
            ent.active, ent.created_at,
            a.name AS app_name,
            c.name AS connector_name
       FROM entitlements ent
       LEFT JOIN applications a ON a.id = ent.app_id
       LEFT JOIN connectors c ON c.id = ent.connector_id
      WHERE ent.is_birthright = 1
      ORDER BY ent.name`,
    [],
  );
  res.json({
    data: rows.map((r) => {
      const rule = parseStoredRule(r.birthright_rule);
      return { ...r, rule_summary: summarizeRule(rule) };
    }),
  });
}));

// POST / — create birthright entitlement
router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    return;
  }
  const d = parsed.data;
  const id = uuidv4();
  const slug = d.slug ?? slugify(d.name);
  const ruleJson = d.birthright_rule ? JSON.stringify(d.birthright_rule) : null;

  try {
    await execute(
      `INSERT INTO entitlements
         (id, name, slug, description, app_id, connector_id, type, risk_score,
          is_birthright, birthright_rule, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        id,
        d.name,
        slug,
        d.description ?? null,
        d.app_id ?? null,
        d.connector_id ?? null,
        d.type,
        d.risk_score,
        ruleJson,
        d.active ? 1 : 0,
      ],
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Duplicate') || msg.includes('uk_ent')) {
      res.status(409).json({ error: 'Entitlement slug already exists for this app/connector' });
      return;
    }
    throw err;
  }
  res.status(201).json({ id, slug });
}));

// PUT /:id
router.put('/:id', asyncHandler(async (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    return;
  }
  const d = parsed.data;
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM entitlements WHERE id = ?`,
    [req.params['id']],
  );
  if (!existing) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  if (d.name !== undefined) { sets.push('name = ?'); params.push(d.name); }
  if (d.description !== undefined) { sets.push('description = ?'); params.push(d.description); }
  if (d.app_id !== undefined) { sets.push('app_id = ?'); params.push(d.app_id); }
  if (d.connector_id !== undefined) { sets.push('connector_id = ?'); params.push(d.connector_id); }
  if (d.type !== undefined) { sets.push('type = ?'); params.push(d.type); }
  if (d.risk_score !== undefined) { sets.push('risk_score = ?'); params.push(d.risk_score); }
  if (d.is_birthright !== undefined) {
    sets.push('is_birthright = ?');
    params.push(d.is_birthright === true || d.is_birthright === 1 ? 1 : 0);
  }
  if (d.active !== undefined) {
    sets.push('active = ?');
    params.push(d.active === true || d.active === 1 ? 1 : 0);
  }
  if (d.birthright_rule !== undefined) {
    sets.push('birthright_rule = ?');
    params.push(d.birthright_rule === null ? null : JSON.stringify(d.birthright_rule));
  }
  if (!sets.length) {
    res.json({ success: true });
    return;
  }
  params.push(req.params['id']);
  await execute(`UPDATE entitlements SET ${sets.join(', ')} WHERE id = ?`, params);
  res.json({ success: true });
}));

// DELETE /:id — remove birthright flag (keeps entitlement) or hard-delete if unused
router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  const id = req.params['id'];
  const inUse = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM user_entitlements WHERE entitlement_id = ? AND revoked_at IS NULL`,
    [id],
  );
  if ((inUse?.n ?? 0) > 0) {
    await execute(
      `UPDATE entitlements SET is_birthright = 0, active = 0 WHERE id = ?`,
      [id],
    );
    res.json({ success: true, action: 'disabled' });
    return;
  }
  await execute(`DELETE FROM entitlements WHERE id = ? AND is_birthright = 1`, [id]);
  res.json({ success: true, action: 'deleted' });
}));

// GET /dry-run — sample of ACTIVE users who would receive at least one new grant
router.get('/dry-run', asyncHandler(async (_req: Request, res: Response) => {
  const employees = await query<{ emp_id: string; full_name: string; dept_id: string | null }>(
    `SELECT emp_id, full_name, dept_id FROM employees WHERE ilg_state = 'ACTIVE' LIMIT 200`,
    [],
  );
  const sample: Array<{ emp_id: string; full_name: string; dept_id: string | null; would_get: string[] }> = [];
  for (const emp of employees) {
    const pending = await dryRunBirthrightForEmployee(emp.emp_id);
    if (!pending.length) continue;
    sample.push({
      emp_id: emp.emp_id,
      full_name: emp.full_name,
      dept_id: emp.dept_id,
      would_get: pending.map((p) => p.name),
    });
    if (sample.length >= 50) break;
  }
  res.json({ data: sample, scanned: employees.length });
}));

// POST /run — reconcile birthright for all ACTIVE employees
router.post('/run', requireRole('ADMIN', 'SUPER_ADMIN'), asyncHandler(async (_req: Request, res: Response) => {
  const employees = await query<{ emp_id: string }>(
    `SELECT emp_id FROM employees WHERE ilg_state = 'ACTIVE'`,
    [],
  );
  let totalGranted = 0;
  let totalRevoked = 0;
  const connectors = new Set<string>();
  for (const emp of employees) {
    const r = await reconcileBirthrightForEmployee(emp.emp_id, { provisionConnectors: false });
    totalGranted += r.granted;
    totalRevoked += r.revoked;
    for (const c of r.connectorIds) connectors.add(c);
  }
  if (connectors.size > 0) {
    void kickConnectorProvision(connectors, 'birthright:batch-run');
  }
  res.json({
    success: true,
    assigned: totalGranted,
    revoked: totalRevoked,
    employees: employees.length,
    connectors_kicked: connectors.size,
  });
}));

export default router;
