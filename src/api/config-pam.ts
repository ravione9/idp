/**
 * Config — PAM API (Credential Vault live; resources/sessions/system-users CRUD)
 * Mounted at /api/admin/pam
 *
 * Vault is SUPER_ADMIN only. Secrets sealed with AES-256-GCM (SESSION_SECRET).
 */
import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { requireRole } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import { query, execute } from '../db/connection.js';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import {
  listVaultEntries,
  createVaultEntry,
  updateVaultEntry,
  deleteVaultEntry,
  checkoutVaultEntry,
} from '../services/credential-vault.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('SUPER_ADMIN'));

function actor(req: Request): string {
  return req.user?.empId ?? 'unknown';
}

function httpErr(res: Response, err: unknown): boolean {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = Number((err as { status: number }).status) || 400;
    res.status(status).json({ error: err instanceof Error ? err.message : 'Error' });
    return true;
  }
  if (err && typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'ZodError') {
    res.status(400).json({ error: 'Invalid body', details: err });
    return true;
  }
  return false;
}

// ── Vault ────────────────────────────────────────────────────────────────────

router.get('/vault', asyncHandler(async (_req: Request, res: Response) => {
  res.json({ data: await listVaultEntries() });
}));

router.post('/vault', asyncHandler(async (req: Request, res: Response) => {
  try {
    const created = await createVaultEntry(req.body, actor(req));
    res.status(201).json(created);
  } catch (err) {
    if (httpErr(res, err)) return;
    throw err;
  }
}));

router.put('/vault/:id', asyncHandler(async (req: Request, res: Response) => {
  try {
    await updateVaultEntry(req.params['id']!, req.body, actor(req));
    res.json({ success: true });
  } catch (err) {
    if (httpErr(res, err)) return;
    throw err;
  }
}));

router.delete('/vault/:id', asyncHandler(async (req: Request, res: Response) => {
  try {
    await deleteVaultEntry(req.params['id']!, actor(req));
    res.json({ success: true });
  } catch (err) {
    if (httpErr(res, err)) return;
    throw err;
  }
}));

router.post('/vault/:id/checkout', asyncHandler(async (req: Request, res: Response) => {
  try {
    const result = await checkoutVaultEntry(req.params['id']!, actor(req));
    res.json(result);
  } catch (err) {
    if (httpErr(res, err)) return;
    throw err;
  }
}));

// ── Resources ────────────────────────────────────────────────────────────────

router.get('/resources', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await query(
    `SELECT id, name, type, hostname, port, username, description, tags,
            access_policy, record_sessions, jit_enabled, active, created_at, updated_at
       FROM pam_resources ORDER BY name`,
    [],
  );
  res.json({ data: rows });
}));

const resourceSchema = z.object({
  name: z.string().min(1).max(150),
  type: z.enum(['SSH', 'RDP', 'DATABASE', 'WEB', 'WINDOWS']).default('SSH'),
  hostname: z.string().max(255).optional().nullable(),
  port: z.number().int().min(1).max(65535).optional().nullable(),
  username: z.string().max(100).optional().nullable(),
  description: z.string().max(2000).optional().nullable(),
  access_policy: z.enum(['REQUEST', 'DIRECT', 'DENIED']).optional().default('REQUEST'),
  record_sessions: z.boolean().optional().default(true),
  jit_enabled: z.boolean().optional().default(true),
  active: z.boolean().optional().default(true),
});

router.post('/resources', asyncHandler(async (req: Request, res: Response) => {
  try {
    const d = resourceSchema.parse(req.body);
    const id = uuidv4();
    await execute(
      `INSERT INTO pam_resources
         (id, name, type, hostname, port, username, description, access_policy,
          record_sessions, jit_enabled, active, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, d.name, d.type, d.hostname ?? null, d.port ?? null, d.username ?? null,
        d.description ?? null, d.access_policy,
        d.record_sessions ? 1 : 0, d.jit_enabled ? 1 : 0, d.active ? 1 : 0, actor(req),
      ],
    );
    res.status(201).json({ id });
  } catch (err) {
    if (httpErr(res, err)) return;
    throw err;
  }
}));

router.put('/resources/:id', asyncHandler(async (req: Request, res: Response) => {
  try {
    const d = resourceSchema.partial().parse(req.body);
    await execute(
      `UPDATE pam_resources SET
         name = COALESCE(?, name),
         type = COALESCE(?, type),
         hostname = COALESCE(?, hostname),
         port = COALESCE(?, port),
         username = COALESCE(?, username),
         description = COALESCE(?, description),
         access_policy = COALESCE(?, access_policy),
         record_sessions = COALESCE(?, record_sessions),
         jit_enabled = COALESCE(?, jit_enabled),
         active = COALESCE(?, active),
         updated_at = UTC_TIMESTAMP()
       WHERE id = ?`,
      [
        d.name ?? null, d.type ?? null, d.hostname ?? null, d.port ?? null,
        d.username ?? null, d.description ?? null, d.access_policy ?? null,
        d.record_sessions === undefined ? null : (d.record_sessions ? 1 : 0),
        d.jit_enabled === undefined ? null : (d.jit_enabled ? 1 : 0),
        d.active === undefined ? null : (d.active ? 1 : 0),
        req.params['id'],
      ],
    );
    res.json({ success: true });
  } catch (err) {
    if (httpErr(res, err)) return;
    throw err;
  }
}));

router.delete('/resources/:id', asyncHandler(async (req: Request, res: Response) => {
  await execute(`DELETE FROM pam_resources WHERE id = ?`, [req.params['id']]);
  res.json({ success: true });
}));

// ── Sessions ─────────────────────────────────────────────────────────────────

router.get('/sessions', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await query(
    `SELECT id, resource_id, emp_id, status, started_at, ended_at, recording_url, justification
       FROM pam_sessions ORDER BY started_at DESC LIMIT 200`,
    [],
  );
  res.json({ data: rows });
}));

router.post('/sessions/:id/terminate', asyncHandler(async (req: Request, res: Response) => {
  await execute(
    `UPDATE pam_sessions SET status = 'TERMINATED', ended_at = UTC_TIMESTAMP()
      WHERE id = ? AND status = 'ACTIVE'`,
    [req.params['id']],
  );
  res.json({ success: true });
}));

// ── System users ─────────────────────────────────────────────────────────────

router.get('/system-users', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await query(
    `SELECT id, name, type, owner_emp_id, description, source_system, last_seen_at,
            credential_id, rotation_required, active, created_at, updated_at
       FROM system_users ORDER BY name`,
    [],
  );
  res.json({ data: rows });
}));

const sysUserSchema = z.object({
  name: z.string().min(1).max(150),
  type: z.enum(['SERVICE_ACCOUNT', 'API_CLIENT', 'ROBOT', 'SHARED']).optional().default('SERVICE_ACCOUNT'),
  owner_emp_id: z.string().max(20).optional().nullable(),
  description: z.string().max(2000).optional().nullable(),
  source_system: z.string().max(80).optional().nullable(),
  credential_id: z.string().max(36).optional().nullable(),
  rotation_required: z.boolean().optional().default(false),
  active: z.boolean().optional().default(true),
});

router.post('/system-users', asyncHandler(async (req: Request, res: Response) => {
  try {
    const d = sysUserSchema.parse(req.body);
    const id = uuidv4();
    await execute(
      `INSERT INTO system_users
         (id, name, type, owner_emp_id, description, source_system, credential_id, rotation_required, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, d.name, d.type, d.owner_emp_id ?? null, d.description ?? null,
        d.source_system ?? null, d.credential_id ?? null,
        d.rotation_required ? 1 : 0, d.active ? 1 : 0,
      ],
    );
    res.status(201).json({ id });
  } catch (err) {
    if (httpErr(res, err)) return;
    throw err;
  }
}));

router.delete('/system-users/:id', asyncHandler(async (req: Request, res: Response) => {
  await execute(`DELETE FROM system_users WHERE id = ?`, [req.params['id']]);
  res.json({ success: true });
}));

router.use((_req, res) => {
  res.status(404).json({ error: 'PAM route not found' });
});

export default router;
