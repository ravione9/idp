/**
 * Personal Credential Vault — owner-scoped secrets for any authenticated user.
 * Separate from PAM `credential_vault_entries` (SUPER_ADMIN). Same AES-GCM seal.
 */
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { query, queryOne, execute } from '../db/connection.js';
import { sealSecret, openSecret } from '../utils/secret-box.js';
import { appendAuditLog } from '../utils/audit-log.js';
import logger from '../utils/logger.js';

export const USER_VAULT_TYPES = ['PASSWORD', 'SSH_KEY', 'API_TOKEN', 'NOTE'] as const;
export type UserVaultType = (typeof USER_VAULT_TYPES)[number];

export interface UserVaultEntryPublic {
  id: string;
  name: string;
  type: UserVaultType;
  username: string | null;
  notes: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

const createSchema = z.object({
  name: z.string().min(1).max(150),
  type: z.enum(USER_VAULT_TYPES).default('PASSWORD'),
  username: z.string().max(100).optional().nullable(),
  secret: z.string().min(1).max(32_000),
  notes: z.string().max(500).optional().nullable(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(150).optional(),
  type: z.enum(USER_VAULT_TYPES).optional(),
  username: z.string().max(100).optional().nullable(),
  secret: z.string().min(1).max(32_000).optional(),
  notes: z.string().max(500).optional().nullable(),
  active: z.boolean().optional(),
});

export async function listUserVaultEntries(empId: string): Promise<UserVaultEntryPublic[]> {
  return query<UserVaultEntryPublic>(
    `SELECT id, name, type, username, notes, active, created_at, updated_at
       FROM user_vault_entries
      WHERE emp_id = ?
      ORDER BY name`,
    [empId],
  );
}

export async function createUserVaultEntry(
  empId: string,
  input: unknown,
): Promise<{ id: string }> {
  const d = createSchema.parse(input);
  const id = uuidv4();
  await execute(
    `INSERT INTO user_vault_entries
       (id, emp_id, name, type, username, encrypted_secret, notes, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    [id, empId, d.name, d.type, d.username ?? null, sealSecret(d.secret), d.notes ?? null],
  );
  await appendAuditLog(empId, 'USER_VAULT_CREATE', id, { name: d.name, type: d.type });
  return { id };
}

export async function updateUserVaultEntry(
  empId: string,
  id: string,
  input: unknown,
): Promise<void> {
  const d = updateSchema.parse(input);
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM user_vault_entries WHERE id = ? AND emp_id = ?`,
    [id, empId],
  );
  if (!existing) throw Object.assign(new Error('Not found'), { status: 404 });

  const sets: string[] = ['updated_at = UTC_TIMESTAMP()'];
  const params: unknown[] = [];

  if (d.name !== undefined) { sets.push('name = ?'); params.push(d.name); }
  if (d.type !== undefined) { sets.push('type = ?'); params.push(d.type); }
  if (d.username !== undefined) { sets.push('username = ?'); params.push(d.username); }
  if (d.notes !== undefined) { sets.push('notes = ?'); params.push(d.notes); }
  if (d.active !== undefined) { sets.push('active = ?'); params.push(d.active ? 1 : 0); }
  if (d.secret !== undefined) {
    sets.push('encrypted_secret = ?');
    params.push(sealSecret(d.secret));
  }

  params.push(id, empId);
  await execute(
    `UPDATE user_vault_entries SET ${sets.join(', ')} WHERE id = ? AND emp_id = ?`,
    params,
  );
  await appendAuditLog(empId, 'USER_VAULT_UPDATE', id, { fields: Object.keys(d) });
}

export async function deleteUserVaultEntry(empId: string, id: string): Promise<void> {
  const r = await execute(
    `DELETE FROM user_vault_entries WHERE id = ? AND emp_id = ?`,
    [id, empId],
  );
  if (r.affectedRows === 0) throw Object.assign(new Error('Not found'), { status: 404 });
  await appendAuditLog(empId, 'USER_VAULT_DELETE', id, {});
}

export async function revealUserVaultEntry(
  empId: string,
  id: string,
): Promise<{ secret: string; username: string | null; name: string; type: string }> {
  const row = await queryOne<{
    id: string;
    name: string;
    type: string;
    username: string | null;
    encrypted_secret: string;
    active: number;
  }>(
    `SELECT id, name, type, username, encrypted_secret, active
       FROM user_vault_entries WHERE id = ? AND emp_id = ?`,
    [id, empId],
  );
  if (!row || row.active !== 1) {
    throw Object.assign(new Error('Not found or inactive'), { status: 404 });
  }

  let secret: string;
  try {
    secret = openSecret(row.encrypted_secret);
  } catch (err) {
    logger.error({ id, empId, err }, 'User vault decrypt failed');
    throw Object.assign(new Error('Failed to decrypt credential'), { status: 500 });
  }

  await appendAuditLog(empId, 'USER_VAULT_REVEAL', id, {
    name: row.name,
    type: row.type,
  });

  return {
    secret,
    username: row.username,
    name: row.name,
    type: row.type,
  };
}
