/**
 * WebAuthn / passkey registration and authentication.
 */
import crypto from 'node:crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type VerifiedRegistrationResponse,
  type VerifiedAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import { query, queryOne } from '../db/connection.js';
import { redis } from './session-store.js';
import { getPublicOrigin } from '../utils/request-context.js';
import logger from '../utils/logger.js';
import { isMethodAllowed } from './mfa-methods.js';

const CHALLENGE_PREFIX = 'lilg:webauthn-challenge:';
const CHALLENGE_TTL_S = 300;

function rpIdFromOrigin(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return process.env['WEBAUTHN_RP_ID'] ?? 'localhost';
  }
}

function challengeKey(id: string): string {
  return `${CHALLENGE_PREFIX}${id}`;
}

interface StoredChallenge {
  empId: string;
  type: 'registration' | 'authentication';
  challenge: string;
}

export interface WebAuthnCredentialRow {
  id: string;
  emp_id: string;
  public_key: Buffer;
  counter: number;
  transports: unknown;
  name: string | null;
}

async function saveChallenge(id: string, data: StoredChallenge): Promise<void> {
  await redis.set(challengeKey(id), JSON.stringify(data), 'EX', CHALLENGE_TTL_S);
}

async function loadChallenge(id: string): Promise<StoredChallenge | null> {
  const raw = await redis.get(challengeKey(id));
  if (!raw) return null;
  await redis.del(challengeKey(id));
  return JSON.parse(raw) as StoredChallenge;
}

async function listCredentials(empId: string): Promise<WebAuthnCredentialRow[]> {
  return query<WebAuthnCredentialRow>(
    `SELECT id, emp_id, public_key, counter, transports, name
       FROM webauthn_credentials WHERE emp_id = ? ORDER BY created_at DESC`,
    [empId],
  );
}

export async function getWebAuthnRegistrationOptions(
  empId: string,
  email: string,
  origin: string,
): Promise<{ options: Awaited<ReturnType<typeof generateRegistrationOptions>>; challengeId: string }> {
  if (!(await isMethodAllowed('webauthn', empId))) {
    throw new Error('WebAuthn is not enabled by policy');
  }

  const existing = await listCredentials(empId);
  const rpID = process.env['WEBAUTHN_RP_ID'] ?? rpIdFromOrigin(origin);
  const rpName = process.env['WEBAUTHN_RP_NAME'] ?? 'Lenskart IdP';

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: email,
    userDisplayName: email,
    userID: Buffer.from(empId),
    attestationType: 'none',
    excludeCredentials: existing.map((c) => credDescriptor(c.id, parseTransports(c.transports))),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });

  const challengeId = crypto.randomUUID();
  await saveChallenge(challengeId, {
    empId,
    type: 'registration',
    challenge: options.challenge,
  });

  return { options, challengeId };
}

function parseTransports(raw: unknown): AuthenticatorTransportFuture[] | undefined {
  if (!raw) return undefined;
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr as AuthenticatorTransportFuture[] : undefined;
  } catch {
    return undefined;
  }
}

function credDescriptor(id: string, transports?: AuthenticatorTransportFuture[]) {
  return transports?.length ? { id, transports } : { id };
}

export async function verifyWebAuthnRegistration(
  empId: string,
  challengeId: string,
  response: RegistrationResponseJSON,
  origin: string,
  credentialName?: string,
): Promise<void> {
  const stored = await loadChallenge(challengeId);
  if (!stored || stored.type !== 'registration' || stored.empId !== empId) {
    throw new Error('Registration challenge expired — try again');
  }

  const rpID = process.env['WEBAUTHN_RP_ID'] ?? rpIdFromOrigin(origin);
  let verification: VerifiedRegistrationResponse;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: stored.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : 'Registration verification failed');
  }

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error('Passkey registration could not be verified');
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  await query(
    `INSERT INTO webauthn_credentials
       (id, emp_id, public_key, counter, transports, aaguid, name)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       public_key = VALUES(public_key),
       counter = VALUES(counter),
       transports = VALUES(transports),
       name = COALESCE(VALUES(name), name)`,
    [
      credential.id,
      empId,
      Buffer.from(credential.publicKey),
      credential.counter,
      JSON.stringify(response.response.transports ?? []),
      null,
      credentialName?.slice(0, 150) ?? `${credentialDeviceType}${credentialBackedUp ? ' (synced)' : ''}`,
    ],
  );
  logger.info({ empId, credentialId: credential.id }, 'WebAuthn credential registered');
}

export async function getWebAuthnAuthenticationOptions(
  empId: string,
  origin: string,
): Promise<{ options: Awaited<ReturnType<typeof generateAuthenticationOptions>>; challengeId: string }> {
  const creds = await listCredentials(empId);
  if (creds.length === 0) throw new Error('No passkeys registered');

  const rpID = process.env['WEBAUTHN_RP_ID'] ?? rpIdFromOrigin(origin);
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'preferred',
    allowCredentials: creds.map((c) => credDescriptor(c.id, parseTransports(c.transports))),
  });

  const challengeId = crypto.randomUUID();
  await saveChallenge(challengeId, {
    empId,
    type: 'authentication',
    challenge: options.challenge,
  });

  return { options, challengeId };
}

export async function verifyWebAuthnAuthentication(
  empId: string,
  challengeId: string,
  response: AuthenticationResponseJSON,
  origin: string,
): Promise<boolean> {
  const stored = await loadChallenge(challengeId);
  if (!stored || stored.type !== 'authentication' || stored.empId !== empId) {
    throw new Error('Authentication challenge expired — try again');
  }

  const cred = await queryOne<WebAuthnCredentialRow>(
    `SELECT id, emp_id, public_key, counter, transports, name
       FROM webauthn_credentials WHERE id = ? AND emp_id = ? LIMIT 1`,
    [response.id, empId],
  );
  if (!cred) return false;

  const rpID = process.env['WEBAUTHN_RP_ID'] ?? rpIdFromOrigin(origin);
  const transports = parseTransports(cred.transports);
  let verification: VerifiedAuthenticationResponse;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: stored.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: cred.id,
        publicKey: new Uint8Array(cred.public_key),
        counter: Number(cred.counter),
        ...(transports?.length ? { transports } : {}),
      },
    });
  } catch {
    return false;
  }

  if (!verification.verified) return false;

  await query(
    `UPDATE webauthn_credentials SET counter = ?, last_used_at = UTC_TIMESTAMP() WHERE id = ?`,
    [verification.authenticationInfo.newCounter, cred.id],
  );
  return true;
}

export async function deleteWebAuthnCredentials(empId: string): Promise<void> {
  await query('DELETE FROM webauthn_credentials WHERE emp_id = ?', [empId]);
}

export async function deleteWebAuthnCredential(empId: string, credentialId: string): Promise<void> {
  await query('DELETE FROM webauthn_credentials WHERE emp_id = ? AND id = ?', [empId, credentialId]);
}

export async function listWebAuthnCredentialsForUser(empId: string): Promise<Array<{ id: string; name: string | null; lastUsedAt: string | null; createdAt: string }>> {
  const rows = await query<{ id: string; name: string | null; last_used_at: string | null; created_at: string }>(
    `SELECT id, name, last_used_at, created_at FROM webauthn_credentials WHERE emp_id = ? ORDER BY created_at DESC`,
    [empId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
  }));
}

export function resolveWebAuthnOrigin(req: { headers: Record<string, string | string[] | undefined> }): string {
  return getPublicOrigin(req as Parameters<typeof getPublicOrigin>[0]);
}

export async function hasWebAuthnCredentials(empId: string): Promise<boolean> {
  const row = await queryOne<{ n: number }>(
    'SELECT COUNT(*) AS n FROM webauthn_credentials WHERE emp_id = ?',
    [empId],
  );
  return (row?.n ?? 0) > 0;
}
