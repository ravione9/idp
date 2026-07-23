/**
 * Admin RADIUS / VPN configuration API
 * Mounted at /api/admin/radius
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../auth/middleware.js';
import { requireRole, requirePortalModule } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import { query, queryOne, execute } from '../db/connection.js';
import { sealSecret, openSecret } from '../utils/secret-box.js';
import { authenticateRadius } from '../services/radius-auth.js';
import { config } from '../config.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('ADMIN', 'SUPER_ADMIN'), requirePortalModule('authentication'));

function actor(req: Request): string | null {
  return (req as unknown as { user?: { empId?: string } }).user?.empId ?? null;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
router.get('/overview', asyncHandler(async (_req: Request, res: Response) => {
  const [clients, policies, profiles, accepts, rejects] = await Promise.all([
    queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM radius_clients WHERE active = 1', []),
    queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM radius_auth_policies WHERE active = 1', []),
    queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM vpn_profiles WHERE active = 1', []),
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM radius_auth_log WHERE result = 'ACCEPT' AND ts >= (UTC_TIMESTAMP() - INTERVAL 24 HOUR)`,
      [],
    ),
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM radius_auth_log WHERE result = 'REJECT' AND ts >= (UTC_TIMESTAMP() - INTERVAL 24 HOUR)`,
      [],
    ),
  ]);
  res.json({
    data: {
      activeClients: Number(clients?.n ?? 0),
      activePolicies: Number(policies?.n ?? 0),
      activeVpnProfiles: Number(profiles?.n ?? 0),
      accepts24h: Number(accepts?.n ?? 0),
      rejects24h: Number(rejects?.n ?? 0),
      udpEnabled: config.radius.udpEnabled,
      udpPort: config.radius.udpPort,
      restEndpoint: '/api/internal/radius/authenticate',
    },
  });
}));

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------
router.get('/clients', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await query<{
    id: string; name: string; nas_ip: string; client_type: string; vendor: string | null;
    description: string | null; active: number; created_at: string; updated_at: string;
  }>(
    `SELECT id, name, nas_ip, client_type, vendor, description, active, created_at, updated_at
     FROM radius_clients ORDER BY name`,
    [],
  );
  res.json({
    data: rows.map((r) => ({
      ...r,
      has_secret: true,
      secret_masked: '••••••••',
    })),
  });
}));

const ClientSchema = z.object({
  name: z.string().min(1).max(150),
  nasIp: z.string().min(1).max(64),
  sharedSecret: z.string().min(4).max(128).optional(),
  clientType: z.enum(['VPN', 'WIRELESS', 'SWITCH', 'OTHER']).default('VPN'),
  vendor: z.string().max(80).optional().nullable(),
  description: z.string().max(512).optional().nullable(),
  active: z.boolean().optional(),
});

router.post('/clients', asyncHandler(async (req: Request, res: Response) => {
  const parsed = ClientSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid client', details: parsed.error.flatten() });
    return;
  }
  if (!parsed.data.sharedSecret) {
    res.status(400).json({ error: 'sharedSecret is required' });
    return;
  }
  const id = uuidv4();
  await execute(
    `INSERT INTO radius_clients
       (id, name, nas_ip, shared_secret, client_type, vendor, description, active, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      parsed.data.name,
      parsed.data.nasIp.trim(),
      sealSecret(parsed.data.sharedSecret),
      parsed.data.clientType,
      parsed.data.vendor ?? null,
      parsed.data.description ?? null,
      parsed.data.active === false ? 0 : 1,
      actor(req),
    ],
  );
  res.status(201).json({ id });
}));

router.put('/clients/:id', asyncHandler(async (req: Request, res: Response) => {
  const parsed = ClientSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid client', details: parsed.error.flatten() });
    return;
  }
  const existing = await queryOne<{ id: string }>('SELECT id FROM radius_clients WHERE id = ?', [req.params['id']]);
  if (!existing) { res.status(404).json({ error: 'Not found' }); return; }

  const d = parsed.data;
  const sets: string[] = [];
  const params: unknown[] = [];
  if (d.name !== undefined) { sets.push('name = ?'); params.push(d.name); }
  if (d.nasIp !== undefined) { sets.push('nas_ip = ?'); params.push(d.nasIp.trim()); }
  if (d.sharedSecret) { sets.push('shared_secret = ?'); params.push(sealSecret(d.sharedSecret)); }
  if (d.clientType !== undefined) { sets.push('client_type = ?'); params.push(d.clientType); }
  if (d.vendor !== undefined) { sets.push('vendor = ?'); params.push(d.vendor); }
  if (d.description !== undefined) { sets.push('description = ?'); params.push(d.description); }
  if (d.active !== undefined) { sets.push('active = ?'); params.push(d.active ? 1 : 0); }
  if (!sets.length) { res.json({ success: true }); return; }
  params.push(req.params['id']);
  await execute(`UPDATE radius_clients SET ${sets.join(', ')} WHERE id = ?`, params);
  res.json({ success: true });
}));

router.delete('/clients/:id', asyncHandler(async (req: Request, res: Response) => {
  await execute('DELETE FROM radius_clients WHERE id = ?', [req.params['id']]);
  res.json({ success: true });
}));

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------
router.get('/policies', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await query(
    `SELECT id, name, description, priority, client_type, vendor, group_ids_json,
            require_mfa, require_mfa_enrolled, reply_attributes, active, created_at, updated_at
     FROM radius_auth_policies ORDER BY priority ASC, name ASC`,
    [],
  );
  res.json({ data: rows });
}));

const PolicySchema = z.object({
  name: z.string().min(1).max(150),
  description: z.string().max(2000).optional().nullable(),
  priority: z.number().int().min(0).max(10000).default(100),
  clientType: z.enum(['VPN', 'WIRELESS', 'SWITCH', 'OTHER', 'ANY']).default('ANY'),
  vendor: z.string().max(80).optional().nullable(),
  groupIds: z.array(z.string()).optional().nullable(),
  requireMfa: z.boolean().optional(),
  requireMfaEnrolled: z.boolean().optional(),
  replyAttributes: z.record(z.string()).optional().nullable(),
  active: z.boolean().optional(),
});

router.post('/policies', asyncHandler(async (req: Request, res: Response) => {
  const parsed = PolicySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid policy', details: parsed.error.flatten() });
    return;
  }
  const id = uuidv4();
  const d = parsed.data;
  await execute(
    `INSERT INTO radius_auth_policies
       (id, name, description, priority, client_type, vendor, group_ids_json,
        require_mfa, require_mfa_enrolled, reply_attributes, active, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, d.name, d.description ?? null, d.priority, d.clientType, d.vendor ?? null,
      d.groupIds ? JSON.stringify(d.groupIds) : null,
      d.requireMfa ? 1 : 0,
      d.requireMfaEnrolled || d.requireMfa ? 1 : 0,
      d.replyAttributes ? JSON.stringify(d.replyAttributes) : null,
      d.active === false ? 0 : 1,
      actor(req),
    ],
  );
  res.status(201).json({ id });
}));

router.put('/policies/:id', asyncHandler(async (req: Request, res: Response) => {
  const parsed = PolicySchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid policy', details: parsed.error.flatten() });
    return;
  }
  const d = parsed.data;
  const sets: string[] = [];
  const params: unknown[] = [];
  if (d.name !== undefined) { sets.push('name = ?'); params.push(d.name); }
  if (d.description !== undefined) { sets.push('description = ?'); params.push(d.description); }
  if (d.priority !== undefined) { sets.push('priority = ?'); params.push(d.priority); }
  if (d.clientType !== undefined) { sets.push('client_type = ?'); params.push(d.clientType); }
  if (d.vendor !== undefined) { sets.push('vendor = ?'); params.push(d.vendor); }
  if (d.groupIds !== undefined) {
    sets.push('group_ids_json = ?');
    params.push(d.groupIds ? JSON.stringify(d.groupIds) : null);
  }
  if (d.requireMfa !== undefined) { sets.push('require_mfa = ?'); params.push(d.requireMfa ? 1 : 0); }
  if (d.requireMfaEnrolled !== undefined) {
    sets.push('require_mfa_enrolled = ?');
    params.push(d.requireMfaEnrolled ? 1 : 0);
  }
  if (d.replyAttributes !== undefined) {
    sets.push('reply_attributes = ?');
    params.push(d.replyAttributes ? JSON.stringify(d.replyAttributes) : null);
  }
  if (d.active !== undefined) { sets.push('active = ?'); params.push(d.active ? 1 : 0); }
  if (!sets.length) { res.json({ success: true }); return; }
  params.push(req.params['id']);
  await execute(`UPDATE radius_auth_policies SET ${sets.join(', ')} WHERE id = ?`, params);
  res.json({ success: true });
}));

router.delete('/policies/:id', asyncHandler(async (req: Request, res: Response) => {
  await execute('DELETE FROM radius_auth_policies WHERE id = ?', [req.params['id']]);
  res.json({ success: true });
}));

// ---------------------------------------------------------------------------
// VPN profiles
// ---------------------------------------------------------------------------
router.get('/vpn-profiles', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await query(
    `SELECT v.*, c.name AS radius_client_name, p.name AS policy_name
     FROM vpn_profiles v
     LEFT JOIN radius_clients c ON c.id = v.radius_client_id
     LEFT JOIN radius_auth_policies p ON p.id = v.policy_id
     ORDER BY v.name`,
    [],
  );
  res.json({ data: rows });
}));

const VpnSchema = z.object({
  name: z.string().min(1).max(150),
  slug: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/),
  vendor: z.string().min(1).max(80).default('other'),
  description: z.string().max(2000).optional().nullable(),
  radiusClientId: z.string().min(1).max(36).optional().nullable(),
  samlSpId: z.string().max(36).optional().nullable(),
  policyId: z.string().min(1).max(36).optional().nullable(),
  connectionHint: z.string().max(255).optional().nullable(),
  instructions: z.string().max(8000).optional().nullable(),
  active: z.boolean().optional(),
});

router.post('/vpn-profiles', asyncHandler(async (req: Request, res: Response) => {
  const parsed = VpnSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid VPN profile', details: parsed.error.flatten() });
    return;
  }
  const id = uuidv4();
  const d = parsed.data;
  await execute(
    `INSERT INTO vpn_profiles
       (id, name, slug, vendor, description, radius_client_id, saml_sp_id, policy_id,
        connection_hint, instructions, active, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, d.name, d.slug, d.vendor, d.description ?? null,
      d.radiusClientId ?? null, d.samlSpId ?? null, d.policyId ?? null,
      d.connectionHint ?? null, d.instructions ?? null,
      d.active === false ? 0 : 1, actor(req),
    ],
  );
  res.status(201).json({ id });
}));

router.put('/vpn-profiles/:id', asyncHandler(async (req: Request, res: Response) => {
  const parsed = VpnSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid VPN profile', details: parsed.error.flatten() });
    return;
  }
  const d = parsed.data;
  const sets: string[] = [];
  const params: unknown[] = [];
  const map: Array<[keyof typeof d, string]> = [
    ['name', 'name'], ['slug', 'slug'], ['vendor', 'vendor'], ['description', 'description'],
    ['radiusClientId', 'radius_client_id'], ['samlSpId', 'saml_sp_id'], ['policyId', 'policy_id'],
    ['connectionHint', 'connection_hint'], ['instructions', 'instructions'],
  ];
  for (const [js, col] of map) {
    if (d[js] !== undefined) { sets.push(`${col} = ?`); params.push(d[js]); }
  }
  if (d.active !== undefined) { sets.push('active = ?'); params.push(d.active ? 1 : 0); }
  if (!sets.length) { res.json({ success: true }); return; }
  params.push(req.params['id']);
  await execute(`UPDATE vpn_profiles SET ${sets.join(', ')} WHERE id = ?`, params);
  res.json({ success: true });
}));

router.delete('/vpn-profiles/:id', asyncHandler(async (req: Request, res: Response) => {
  await execute('DELETE FROM vpn_profiles WHERE id = ?', [req.params['id']]);
  res.json({ success: true });
}));

// ---------------------------------------------------------------------------
// Auth log + test
// ---------------------------------------------------------------------------
router.get('/logs', asyncHandler(async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(String(req.query['limit'] ?? '100'), 10) || 100, 500);
  const result = typeof req.query['result'] === 'string' ? req.query['result'].trim().toUpperCase() : '';
  const q = typeof req.query['q'] === 'string' ? req.query['q'].trim() : '';
  const where: string[] = ['1=1'];
  const params: unknown[] = [];
  if (result) { where.push('result = ?'); params.push(result); }
  if (q) {
    where.push('(username LIKE ? OR emp_id LIKE ? OR nas_ip LIKE ? OR reason LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const rows = await query(
    `SELECT id, ts, result, reason, username, emp_id, nas_ip, client_id,
            calling_station_id, policy_id, protocol, reply_json
     FROM radius_auth_log
     WHERE ${where.join(' AND ')}
     ORDER BY ts DESC
     LIMIT ?`,
    [...params, limit],
  );
  res.json({ data: rows });
}));

router.post('/test-auth', asyncHandler(async (req: Request, res: Response) => {
  const body = z.object({
    username: z.string().min(1),
    password: z.string().min(1),
    nasIp: z.string().optional(),
  }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'username and password required' });
    return;
  }
  const result = await authenticateRadius({
    username: body.data.username,
    password: body.data.password,
    nasIp: body.data.nasIp ?? null,
    protocol: 'REST',
  });
  res.json({ data: result });
}));

/** Reveal shared secret once (admin only) — for FreeRADIUS config copy */
router.post('/clients/:id/reveal-secret', asyncHandler(async (req: Request, res: Response) => {
  const row = await queryOne<{ shared_secret: string }>(
    'SELECT shared_secret FROM radius_clients WHERE id = ?',
    [req.params['id']],
  );
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }
  try {
    res.json({ secret: openSecret(row.shared_secret) });
  } catch {
    res.status(500).json({ error: 'Failed to decrypt secret' });
  }
}));

export default router;
