/**
 * Config — OIDC Clients API
 * Mounted at /api/admin/oidc-clients
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import { requireAuth } from '../auth/middleware.js';
import { requireRole } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import { query, queryOne, execute } from '../db/connection.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('SUPER_ADMIN'));

function genSecret(len = 32): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s;
}

// GET /
router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  // Determine which columns actually exist (schema may be at different migration levels)
  const colRows = await query<{ COLUMN_NAME: string }>(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'oidc_clients'`,
    [],
  );
  const cols = new Set(colRows.map(r => r.COLUMN_NAME));

  const nameCol   = cols.has('name')                     ? 'name'                     : 'client_id AS name';
  const authCol   = cols.has('token_endpoint_auth_method') ? 'token_endpoint_auth_method'
                  : cols.has('token_endpoint_auth')        ? 'token_endpoint_auth AS token_endpoint_auth_method'
                  : "'client_secret_basic' AS token_endpoint_auth_method";

  const rows = await query(
    `SELECT id, client_id, ${nameCol}, redirect_uris, scopes, grant_types,
            ${authCol}, active, created_at
     FROM oidc_clients ORDER BY ${cols.has('name') ? 'name' : 'client_id'}`,
    [],
  );
  res.json({ data: rows });
}));

// POST /
router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const { name, redirect_uris = [], scopes = [], grant_types = [], token_endpoint_auth_method = 'client_secret_basic' } = req.body as {
    name: string; redirect_uris?: string[]; scopes?: string[];
    grant_types?: string[]; token_endpoint_auth_method?: string;
  };
  if (!name) { res.status(400).json({ error: 'name required' }); return; }
  const id = uuidv4();
  const clientId = `client_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  const secret = genSecret();
  const hash = await bcrypt.hash(secret, 10);

  // Check which columns exist before inserting (schema may lag behind)
  const colRows2 = await query<{ COLUMN_NAME: string }>(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'oidc_clients'`,
    [],
  );
  const existCols = new Set(colRows2.map(r => r.COLUMN_NAME));

  if (existCols.has('name') && existCols.has('token_endpoint_auth_method')) {
    await execute(
      `INSERT INTO oidc_clients
         (id, client_id, client_secret_hash, name, redirect_uris, scopes,
          grant_types, token_endpoint_auth_method, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [id, clientId, hash, name,
       JSON.stringify(redirect_uris), JSON.stringify(scopes),
       JSON.stringify(grant_types), token_endpoint_auth_method],
    );
  } else if (existCols.has('token_endpoint_auth')) {
    // Pre-migration 007 schema
    await execute(
      `INSERT INTO oidc_clients
         (id, client_id, client_secret_hash, redirect_uris, scopes,
          grant_types, token_endpoint_auth, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [id, clientId, hash,
       JSON.stringify(redirect_uris), JSON.stringify(scopes),
       JSON.stringify(grant_types), token_endpoint_auth_method],
    );
  } else {
    // Bare minimum — just id, client_id, secret, redirect_uris
    await execute(
      `INSERT INTO oidc_clients
         (id, client_id, client_secret_hash, redirect_uris, scopes, grant_types, active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [id, clientId, hash,
       JSON.stringify(redirect_uris), JSON.stringify(scopes),
       JSON.stringify(grant_types)],
    );
  }
  res.status(201).json({ id, client_id: clientId, client_secret: secret });
}));

// PUT /:id
router.put('/:id', asyncHandler(async (req: Request, res: Response) => {
  const { name, redirect_uris, scopes, grant_types, active } = req.body as {
    name?: string; redirect_uris?: string[]; scopes?: string[];
    grant_types?: string[]; active?: number;
  };
  await execute(
    `UPDATE oidc_clients SET
       name = COALESCE(?, name),
       redirect_uris = COALESCE(?, redirect_uris),
       scopes = COALESCE(?, scopes),
       grant_types = COALESCE(?, grant_types),
       active = COALESCE(?, active)
     WHERE id = ?`,
    [name ?? null,
     redirect_uris ? JSON.stringify(redirect_uris) : null,
     scopes ? JSON.stringify(scopes) : null,
     grant_types ? JSON.stringify(grant_types) : null,
     active ?? null, req.params['id']],
  );
  res.json({ success: true });
}));

// DELETE /:id — soft delete
router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  await execute(`UPDATE oidc_clients SET active = 0 WHERE id = ?`, [req.params['id']]);
  res.json({ success: true });
}));

// POST /:id/rotate-secret
router.post('/:id/rotate-secret', asyncHandler(async (req: Request, res: Response) => {
  const existing = await queryOne<{ id: string }>(`SELECT id FROM oidc_clients WHERE id = ?`, [req.params['id']]);
  if (!existing) { res.status(404).json({ error: 'Not found' }); return; }
  const secret = genSecret();
  const hash = await bcrypt.hash(secret, 10);
  await execute(`UPDATE oidc_clients SET client_secret_hash = ? WHERE id = ?`, [hash, req.params['id']]);
  res.json({ client_secret: secret });
}));

export default router;
