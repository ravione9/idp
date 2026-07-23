/**
 * Seal / open secrets with AES-256-GCM using a key derived from SESSION_SECRET.
 * Used for RADIUS shared secrets at rest.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';

function keyBytes(): Buffer {
  return createHash('sha256').update(config.session.secret, 'utf8').digest();
}

/** Returns `v1.<iv_b64>.<tag_b64>.<ct_b64>` */
export function sealSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ct.toString('base64url')}`;
}

export function openSecret(sealed: string): string {
  if (!sealed.startsWith('v1.')) {
    // Legacy / plaintext (dev only) — return as-is
    return sealed;
  }
  const parts = sealed.split('.');
  if (parts.length !== 4) throw new Error('Invalid sealed secret');
  const iv = Buffer.from(parts[1]!, 'base64url');
  const tag = Buffer.from(parts[2]!, 'base64url');
  const ct = Buffer.from(parts[3]!, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
