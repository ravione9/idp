/**
 * Credential Vault — AES-256-GCM secrets (via secret-box / SESSION_SECRET).
 * SUPER_ADMIN checkout reveals plaintext once and writes an audit event.
 */
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { query, queryOne, execute } from '../db/connection.js';
import { sealSecret, openSecret } from '../utils/secret-box.js';
import { appendAuditLog } from '../utils/audit-log.js';
import logger from '../utils/logger.js';

export const VAULT_TYPES = ['PASSWORD', 'SSH_KEY', 'API_TOKEN', 'DATABASE', 'CERTIFICATE'] as const;
export type VaultType = (typeof VAULT_TYPES)[number];

export interface VaultEntryPublic {
  id: string;
  name: string;
  type: VaultType;
  resource_id: string | null;
  username: string | null;
  rotation_days: number;
  last_rotated_at: string | null;
  next_rotation_at: string | null;
  owner_emp_id: string | null;
  active: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const createSchema = z.object({
  name: z.string().min(1).max(150),
  type: z.enum(VAULT_TYPES).default('PASSWORD'),
  username: z.string().max(100).optional().nullable(),
  secret: z.string().min(1).max(32_000),
  resource_id: z.string().max(36).optional().nullable(),
  rotation_days: z.number().int().min(0).max(3650).optional().default(90),
  owner_emp_id: z.string().max(20).optional().nullable(),
  access_policy: z.record(z.unknown()).optional().nullable(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(150).optional(),
  type: z.enum(VAULT_TYPES).optional(),
  username: z.string().max(100).optional().nullable(),
  secret: z.string().min(1).max(32_000).optional(),
  resource_id: z.string().max(36).optional().nullable(),
  rotation_days: z.number().int().min(0).max(3650).optional(),
  owner_emp_id: z.string().max(20).optional().nullable(),
  active: z.boolean().optional(),
  access_policy: z.record(z.unknown()).optional().nullable(),
});

function nextRotation(days: number): Date | null {
  if (!days || days <= 0) return null;
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

export async function listVaultEntries(): Promise<VaultEntryPublic[]> {
  return query<VaultEntryPublic>(
    `SELECT id, name, type, resource_id, username, rotation_days,
            last_rotated_at, next_rotation_at, owner_emp_id, active,
            created_by, created_at, updated_at
       FROM credential_vault_entries
      ORDER BY name`,
    [],
  );
}

export async function createVaultEntry(
  input: unknown,
  actorEmpId: string,
): Promise<{ id: string }> {
  const d = createSchema.parse(input);
  const id = uuidv4();
  const sealed = sealSecret(d.secret);
  const next = nextRotation(d.rotation_days);
  await execute(
    `INSERT INTO credential_vault_entries
       (id, name, type, resource_id, username, encrypted_secret, rotation_days,
        last_rotated_at, next_rotation_at, owner_emp_id, access_policy, active, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), ?, ?, ?, 1, ?)`,
    [
      id,
      d.name,
      d.type,
      d.resource_id ?? null,
      d.username ?? null,
      sealed,
      d.rotation_days,
      next,
      d.owner_emp_id ?? null,
      d.access_policy ? JSON.stringify(d.access_policy) : null,
      actorEmpId,
    ],
  );
  await appendAuditLog(actorEmpId, 'VAULT_CREATE', id, { name: d.name, type: d.type });
  return { id };
}

export async function updateVaultEntry(
  id: string,
  input: unknown,
  actorEmpId: string,
): Promise<void> {
  const d = updateSchema.parse(input);
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM credential_vault_entries WHERE id = ?`,
    [id],
  );
  if (!existing) throw Object.assign(new Error('Not found'), { status: 404 });

  const sets: string[] = ['updated_at = UTC_TIMESTAMP()'];
  const params: unknown[] = [];

  if (d.name !== undefined) { sets.push('name = ?'); params.push(d.name); }
  if (d.type !== undefined) { sets.push('type = ?'); params.push(d.type); }
  if (d.username !== undefined) { sets.push('username = ?'); params.push(d.username); }
  if (d.resource_id !== undefined) { sets.push('resource_id = ?'); params.push(d.resource_id); }
  if (d.owner_emp_id !== undefined) { sets.push('owner_emp_id = ?'); params.push(d.owner_emp_id); }
  if (d.access_policy !== undefined) {
    sets.push('access_policy = ?');
    params.push(d.access_policy ? JSON.stringify(d.access_policy) : null);
  }
  if (d.active !== undefined) { sets.push('active = ?'); params.push(d.active ? 1 : 0); }
  if (d.rotation_days !== undefined) {
    sets.push('rotation_days = ?');
    params.push(d.rotation_days);
    sets.push('next_rotation_at = ?');
    params.push(nextRotation(d.rotation_days));
  }
  if (d.secret !== undefined) {
    sets.push('encrypted_secret = ?');
    params.push(sealSecret(d.secret));
    sets.push('last_rotated_at = UTC_TIMESTAMP()');
  }

  params.push(id);
  await execute(`UPDATE credential_vault_entries SET ${sets.join(', ')} WHERE id = ?`, params);
  await appendAuditLog(actorEmpId, 'VAULT_UPDATE', id, { fields: Object.keys(d) });
}

export async function deleteVaultEntry(id: string, actorEmpId: string): Promise<void> {
  const r = await execute(`DELETE FROM credential_vault_entries WHERE id = ?`, [id]);
  if (r.affectedRows === 0) throw Object.assign(new Error('Not found'), { status: 404 });
  await appendAuditLog(actorEmpId, 'VAULT_DELETE', id, {});
}

export async function checkoutVaultEntry(
  id: string,
  actorEmpId: string,
): Promise<{ secret: string; username: string | null; name: string; type: string; expires_at: string }> {
  const row = await queryOne<{
    id: string;
    name: string;
    type: string;
    username: string | null;
    encrypted_secret: string;
    active: number;
  }>(
    `SELECT id, name, type, username, encrypted_secret, active
       FROM credential_vault_entries WHERE id = ?`,
    [id],
  );
  if (!row || row.active !== 1) {
    throw Object.assign(new Error('Not found or inactive'), { status: 404 });
  }

  let secret: string;
  try {
    secret = openSecret(row.encrypted_secret);
  } catch (err) {
    logger.error({ id, err }, 'Vault decrypt failed');
    throw Object.assign(new Error('Failed to decrypt credential'), { status: 500 });
  }

  const expires = new Date(Date.now() + 5 * 60 * 1000);
  await appendAuditLog(actorEmpId, 'VAULT_CHECKOUT', id, {
    name: row.name,
    type: row.type,
    expires_at: expires.toISOString(),
  });

  return {
    secret,
    username: row.username,
    name: row.name,
    type: row.type,
    expires_at: expires.toISOString(),
  };
}
