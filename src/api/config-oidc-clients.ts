/**
 * Config — OIDC Clients API (RP registry for the IdP as OP)
 * Mounted at /api/admin/oidc-clients
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { requireRole, requireAnyPortalModule } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import { query, queryOne, execute } from '../db/connection.js';

const router = Router();
router.use(requireAuth);
// Lives under Admin → Applications → OIDC / OAuth (also allow Authentication module)
router.use(requireRole('ADMIN', 'SUPER_ADMIN'), requireAnyPortalModule('applications', 'authentication'));

function genSecret(len = 32): string {
  return crypto.randomBytes(len).toString('base64url');
}

async function oidcColumns(): Promise<Set<string>> {
  const colRows = await query<{ COLUMN_NAME: string }>(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'oidc_clients'`,
    [],
  );
  return new Set(colRows.map((r) => r.COLUMN_NAME));
}

const createSchema = z.object({
  name: z.string().min(1).max(150),
  redirect_uris: z.array(z.string().url()).min(1),
  scopes: z.array(z.string().min(1)).default(['openid', 'email', 'profile']),
  grant_types: z.array(z.string().min(1)).default(['authorization_code', 'refresh_token']),
  response_types: z.array(z.string().min(1)).default(['code']),
  token_endpoint_auth_method: z.enum([
    'client_secret_basic', 'client_secret_post', 'none', 'private_key_jwt',
  ]).default('client_secret_basic'),
  client_type: z.enum(['CONFIDENTIAL', 'PUBLIC']).default('CONFIDENTIAL'),
  require_pkce: z.boolean().default(true),
  catalog_slug: z.string().max(80).optional(),
  category: z.string().max(50).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(150).optional(),
  redirect_uris: z.array(z.string().url()).min(1).optional(),
  scopes: z.array(z.string().min(1)).optional(),
  grant_types: z.array(z.string().min(1)).optional(),
  response_types: z.array(z.string().min(1)).optional(),
  token_endpoint_auth_method: z.enum([
    'client_secret_basic', 'client_secret_post', 'none', 'private_key_jwt',
  ]).optional(),
  client_type: z.enum(['CONFIDENTIAL', 'PUBLIC']).optional(),
  require_pkce: z.boolean().optional(),
  active: z.union([z.boolean(), z.number().int().min(0).max(1)]).optional(),
});

// GET /
router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const cols = await oidcColumns();
  const nameCol = cols.has('name') ? 'name' : 'client_id AS name';
  const authCol = cols.has('token_endpoint_auth_method')
    ? 'token_endpoint_auth_method'
    : cols.has('token_endpoint_auth')
      ? 'token_endpoint_auth AS token_endpoint_auth_method'
      : "'client_secret_basic' AS token_endpoint_auth_method";
  const typeCol = cols.has('client_type') ? 'client_type' : "'CONFIDENTIAL' AS client_type";
  const pkceCol = cols.has('require_pkce') ? 'require_pkce' : '1 AS require_pkce';

  const rows = await query(
    `SELECT id, client_id, ${nameCol}, redirect_uris, scopes, grant_types, response_types,
            ${authCol}, ${typeCol}, ${pkceCol}, active, created_at
     FROM oidc_clients ORDER BY ${cols.has('name') ? 'name' : 'client_id'}`,
    [],
  );
  res.json({ data: rows });
}));

// GET /:id
router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
  const cols = await oidcColumns();
  const nameCol = cols.has('name') ? 'name' : 'client_id AS name';
  const authCol = cols.has('token_endpoint_auth_method')
    ? 'token_endpoint_auth_method'
    : cols.has('token_endpoint_auth')
      ? 'token_endpoint_auth AS token_endpoint_auth_method'
      : "'client_secret_basic' AS token_endpoint_auth_method";
  const typeCol = cols.has('client_type') ? 'client_type' : "'CONFIDENTIAL' AS client_type";
  const pkceCol = cols.has('require_pkce') ? 'require_pkce' : '1 AS require_pkce';

  const appCol = cols.has('app_id') ? ', app_id' : '';
  const row = await queryOne(
    `SELECT id, client_id, ${nameCol}, redirect_uris, scopes, grant_types, response_types,
            ${authCol}, ${typeCol}, ${pkceCol}, active, created_at${appCol}
     FROM oidc_clients WHERE id = ?`,
    [req.params['id']],
  );
  if (!row) {
    res.status(404).json({ error: 'OIDC client not found' });
    return;
  }
  res.json(row);
}));

// POST /
router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }
  const d = { ...parsed.data };
  if (!d.scopes.includes('openid')) {
    res.status(400).json({ error: 'scopes must include openid' });
    return;
  }
  if (d.client_type === 'PUBLIC') {
    d.token_endpoint_auth_method = 'none';
    d.require_pkce = true;
  }

  const id = uuidv4();
  const clientId = `client_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  const secret = genSecret();
  const hash = await bcrypt.hash(secret, 10);

  const redirectJson = JSON.stringify(d.redirect_uris);
  const scopesJson = JSON.stringify(d.scopes);
  const grantsJson = JSON.stringify(d.grant_types);
  const responseJson = JSON.stringify(d.response_types);

  let appId: string | null = null;
  if (d.catalog_slug) {
    const slug = d.catalog_slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
    if (slug) {
      const existing = await queryOne<{ id: string }>(
        `SELECT id FROM applications WHERE slug = ?`,
        [slug],
      );
      if (existing) {
        appId = existing.id;
      } else {
        appId = uuidv4();
        await execute(
          `INSERT INTO applications
             (id, slug, name, category, visibility, sso_enabled, provisioning)
           VALUES (?, ?, ?, ?, 'PUBLIC', 1, 0)`,
          [appId, slug, d.name, d.category ?? null],
        );
      }
    }
  }

  const existCols = await oidcColumns();
  const appCol = appId && existCols.has('app_id') ? ', app_id' : '';
  const appVal = appId && existCols.has('app_id') ? ', ?' : '';
  const appParam = appId && existCols.has('app_id') ? [appId] : [];

  if (existCols.has('name') && existCols.has('token_endpoint_auth_method') && existCols.has('response_types')) {
    const typeCol = existCols.has('client_type') ? ', client_type' : '';
    const typeVal = existCols.has('client_type') ? ', ?' : '';
    const pkceCol = existCols.has('require_pkce') ? ', require_pkce' : '';
    const pkceVal = existCols.has('require_pkce') ? ', ?' : '';
    const extraParams: unknown[] = [];
    if (existCols.has('client_type')) extraParams.push(d.client_type);
    if (existCols.has('require_pkce')) extraParams.push(d.require_pkce ? 1 : 0);

    await execute(
      `INSERT INTO oidc_clients
         (id, client_id, client_secret_hash, name, redirect_uris, scopes,
          grant_types, response_types, token_endpoint_auth_method, active${typeCol}${pkceCol}${appCol})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1${typeVal}${pkceVal}${appVal})`,
      [id, clientId, hash, d.name, redirectJson, scopesJson, grantsJson, responseJson,
       d.token_endpoint_auth_method, ...extraParams, ...appParam],
    );
  } else if (existCols.has('token_endpoint_auth') && existCols.has('response_types')) {
    await execute(
      `INSERT INTO oidc_clients
         (id, client_id, client_secret_hash, redirect_uris, scopes,
          grant_types, response_types, token_endpoint_auth, active${appCol})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1${appVal})`,
      [id, clientId, hash, redirectJson, scopesJson, grantsJson, responseJson,
       d.token_endpoint_auth_method, ...appParam],
    );
  } else if (existCols.has('response_types')) {
    await execute(
      `INSERT INTO oidc_clients
         (id, client_id, client_secret_hash, redirect_uris, scopes, grant_types, response_types, active${appCol})
       VALUES (?, ?, ?, ?, ?, ?, ?, 1${appVal})`,
      [id, clientId, hash, redirectJson, scopesJson, grantsJson, responseJson, ...appParam],
    );
  } else {
    res.status(500).json({ error: 'oidc_clients table is missing required columns — run migrations 010+' });
    return;
  }

  res.status(201).json({
    id,
    client_id: clientId,
    client_secret: secret,
    app_id: appId,
    require_pkce: d.require_pkce,
    client_type: d.client_type,
  });
}));

// PUT /:id
router.put('/:id', asyncHandler(async (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }
  const d = parsed.data;
  const cols = await oidcColumns();

  const sets: string[] = [];
  const vals: unknown[] = [];

  if (d.name !== undefined && cols.has('name')) {
    sets.push('name = ?');
    vals.push(d.name);
  }
  if (d.redirect_uris !== undefined) {
    sets.push('redirect_uris = ?');
    vals.push(JSON.stringify(d.redirect_uris));
  }
  if (d.scopes !== undefined) {
    if (!d.scopes.includes('openid')) {
      res.status(400).json({ error: 'scopes must include openid' });
      return;
    }
    sets.push('scopes = ?');
    vals.push(JSON.stringify(d.scopes));
  }
  if (d.grant_types !== undefined) {
    sets.push('grant_types = ?');
    vals.push(JSON.stringify(d.grant_types));
  }
  if (d.response_types !== undefined && cols.has('response_types')) {
    sets.push('response_types = ?');
    vals.push(JSON.stringify(d.response_types));
  }
  if (d.token_endpoint_auth_method !== undefined) {
    if (cols.has('token_endpoint_auth_method')) {
      sets.push('token_endpoint_auth_method = ?');
      vals.push(d.token_endpoint_auth_method);
    } else if (cols.has('token_endpoint_auth')) {
      sets.push('token_endpoint_auth = ?');
      vals.push(d.token_endpoint_auth_method);
    }
  }
  if (d.client_type !== undefined && cols.has('client_type')) {
    sets.push('client_type = ?');
    vals.push(d.client_type);
  }
  if (d.require_pkce !== undefined && cols.has('require_pkce')) {
    sets.push('require_pkce = ?');
    vals.push(d.require_pkce ? 1 : 0);
  }
  if (d.active !== undefined) {
    sets.push('active = ?');
    vals.push(typeof d.active === 'boolean' ? (d.active ? 1 : 0) : d.active);
  }

  if (!sets.length) {
    res.json({ success: true, updated: false });
    return;
  }

  vals.push(req.params['id']);
  const result = await execute(
    `UPDATE oidc_clients SET ${sets.join(', ')} WHERE id = ?`,
    vals,
  );
  if (result.affectedRows === 0) {
    res.status(404).json({ error: 'OIDC client not found' });
    return;
  }
  res.json({ success: true });
}));

// DELETE /:id
router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  const id = req.params['id'];
  if (!id) {
    res.status(400).json({ error: 'Missing client id' });
    return;
  }

  const existing = await queryOne<{ id: string; client_id: string }>(
    `SELECT id, client_id FROM oidc_clients WHERE id = ?`,
    [id],
  );
  if (!existing) {
    res.status(404).json({ error: 'OIDC client not found' });
    return;
  }

  await execute(`DELETE FROM oauth_tokens WHERE client_id = ?`, [existing.client_id]);
  const result = await execute(`DELETE FROM oidc_clients WHERE id = ?`, [id]);
  if (result.affectedRows === 0) {
    res.status(404).json({ error: 'OIDC client not found' });
    return;
  }

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
