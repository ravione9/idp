/**
 * Config — PAM API (Resources, Sessions, Credential Vault, System Users)
 * Mounted at /api/admin/pam
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../auth/middleware.js';
import { requireRole } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import { query, queryOne, execute } from '../db/connection.js';
import logger from '../utils/logger.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('ADMIN', 'SUPER_ADMIN'));

// ── PAM Resources ──────────────────────────────────────────────────────────

router.get('/resources', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await query(`SELECT * FROM pam_resources WHERE active=1 ORDER BY name`, []);
  res.json({ data: rows });
}));

router.post('/resources', asyncHandler(async (req: Request, res: Response) => {
  const { name, type, hostname, port, username, description, access_policy = 'REQUEST', record_sessions = 1, jit_enabled = 1 } = req.body as {
    name: string; type: string; hostname?: string; port?: number;
    username?: string; description?: string; access_policy?: string;
    record_sessions?: number; jit_enabled?: number;
  };
  if (!name || !type) { res.status(400).json({ error: 'name and type required' }); return; }
  const id = uuidv4();
  const empId = (req as unknown as { user?: { empId?: string } }).user?.empId ?? null;
  await execute(
    `INSERT INTO pam_resources
       (id, name, type, hostname, port, username, description,
        access_policy, record_sessions, jit_enabled, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, type, hostname ?? null, port ?? null, username ?? null,
     description ?? null, access_policy, record_sessions, jit_enabled, empId],
  );
  res.status(201).json({ id });
}));

router.put('/resources/:id', asyncHandler(async (req: Request, res: Response) => {
  const { name, hostname, port, username, description, access_policy, record_sessions, jit_enabled, active } = req.body as Record<string, unknown>;
  await execute(
    `UPDATE pam_resources SET
       name = COALESCE(?, name),
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
    [name ?? null, hostname ?? null, port ?? null, username ?? null,
     description ?? null, access_policy ?? null, record_sessions ?? null,
     jit_enabled ?? null, active ?? null, req.params['id']],
  );
  res.json({ success: true });
}));

router.delete('/resources/:id', asyncHandler(async (req: Request, res: Response) => {
  await execute(`UPDATE pam_resources SET active=0, updated_at=UTC_TIMESTAMP() WHERE id=?`, [req.params['id']]);
  res.json({ success: true });
}));

// ── PAM Sessions ──────────────────────────────────────────────────────────

router.get('/sessions', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await query(
    `SELECT ps.*, r.name AS resource_name, e.full_name AS emp_name
     FROM pam_sessions ps
     LEFT JOIN pam_resources r ON r.id = ps.resource_id
     LEFT JOIN employees e ON e.emp_id = ps.emp_id
     ORDER BY ps.started_at DESC LIMIT 100`,
    [],
  );
  res.json({ data: rows });
}));

router.post('/sessions/:id/terminate', asyncHandler(async (req: Request, res: Response) => {
  await execute(
    `UPDATE pam_sessions SET status='TERMINATED', ended_at=UTC_TIMESTAMP() WHERE id=?`,
    [req.params['id']],
  );
  res.json({ success: true });
}));

// ── Credential Vault ──────────────────────────────────────────────────────

router.get('/vault', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await query(
    `SELECT id, name, type, resource_id, username, rotation_days,
            last_rotated_at, next_rotation_at, owner_emp_id, active, created_at
     FROM credential_vault_entries WHERE active=1 ORDER BY name`,
    [],
  );
  res.json({ data: rows });
}));

router.post('/vault', asyncHandler(async (req: Request, res: Response) => {
  const { name, type = 'PASSWORD', resource_id, username, secret, rotation_days = 90 } = req.body as {
    name: string; type?: string; resource_id?: string;
    username?: string; secret: string; rotation_days?: number;
  };
  if (!name || !secret) { res.status(400).json({ error: 'name and secret required' }); return; }
  const id = uuidv4();
  const empId = (req as unknown as { user?: { empId?: string } }).user?.empId ?? null;
  // Phase 5: Replace with real KMS encryption. For now base64 encode.
  const encrypted_secret = Buffer.from(secret).toString('base64');
  const nextRotation = new Date();
  nextRotation.setDate(nextRotation.getDate() + rotation_days);

  await execute(
    `INSERT INTO credential_vault_entries
       (id, name, type, resource_id, username, encrypted_secret,
        rotation_days, last_rotated_at, next_rotation_at, owner_emp_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), ?, ?, ?)`,
    [id, name, type, resource_id ?? null, username ?? null,
     encrypted_secret, rotation_days, nextRotation.toISOString().slice(0, 19).replace('T', ' '),
     empId, empId],
  );
  res.status(201).json({ id });
}));

router.delete('/vault/:id', asyncHandler(async (req: Request, res: Response) => {
  await execute(`UPDATE credential_vault_entries SET active=0, updated_at=UTC_TIMESTAMP() WHERE id=?`, [req.params['id']]);
  res.json({ success: true });
}));

router.post('/vault/:id/checkout', asyncHandler(async (req: Request, res: Response) => {
  const entry = await queryOne<{ encrypted_secret: string; name: string }>(
    `SELECT encrypted_secret, name FROM credential_vault_entries WHERE id=? AND active=1`,
    [req.params['id']],
  );
  if (!entry) { res.status(404).json({ error: 'Not found' }); return; }
  const empId = (req as unknown as { user?: { empId?: string } }).user?.empId;
  // Phase 5: real KMS decryption. For now decode base64.
  const secret = Buffer.from(entry.encrypted_secret, 'base64').toString('utf8');
  logger.info({ empId, vaultId: req.params['id'], name: entry.name }, 'Vault checkout');
  res.json({ secret });
}));

// ── System Users ──────────────────────────────────────────────────────────

router.get('/system-users', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await query(`SELECT * FROM system_users WHERE active=1 ORDER BY name`, []);
  res.json({ data: rows });
}));

router.post('/system-users', asyncHandler(async (req: Request, res: Response) => {
  const { name, type, owner_emp_id, description, source_system } = req.body as {
    name: string; type: string; owner_emp_id?: string;
    description?: string; source_system?: string;
  };
  if (!name || !type) { res.status(400).json({ error: 'name and type required' }); return; }
  const id = uuidv4();
  await execute(
    `INSERT INTO system_users (id, name, type, owner_emp_id, description, source_system)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, name, type, owner_emp_id ?? null, description ?? null, source_system ?? null],
  );
  res.status(201).json({ id });
}));

router.delete('/system-users/:id', asyncHandler(async (req: Request, res: Response) => {
  await execute(`UPDATE system_users SET active=0, updated_at=UTC_TIMESTAMP() WHERE id=?`, [req.params['id']]);
  res.json({ success: true });
}));

export default router;
