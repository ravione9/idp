import crypto from 'crypto';

/** SHA-256 hex digest for storing agent bearer tokens (never store plaintext). */
export function hashAgentToken(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** Generate a URL-safe agent token shown once to the admin at connector creation. */
export function generateAgentToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}
