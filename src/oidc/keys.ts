/**
 * OIDC Provider signing keys + JWKS.
 * Prefers SAML IdP RSA key when configured; otherwise persists an auto-generated key.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { exportJWK, importPKCS8, type JWK, type KeyLike } from 'jose';
import { config, isSamlEnabled } from '../config.js';
import logger from '../utils/logger.js';

const PERSIST_DIR = process.env['OIDC_KEY_DIR'] ?? process.env['SAML_KEY_DIR'] ?? '/app/data/oidc';
const KEY_FILE = path.join(PERSIST_DIR, 'oidc-op.key');
const KID_FILE = path.join(PERSIST_DIR, 'oidc-op.kid');

let privateKey: KeyLike | null = null;
let publicJwk: JWK | null = null;
let keyId = 'lilg-oidc-1';

function pemToPkcs8(pem: string): string {
  const trimmed = pem.trim();
  if (trimmed.includes('BEGIN PRIVATE KEY')) return trimmed;
  // PKCS#1 RSA → PKCS#8 via Node crypto
  const keyObject = crypto.createPrivateKey(trimmed);
  return keyObject.export({ type: 'pkcs8', format: 'pem' }).toString();
}

function computeKidFromPem(publicPem: string): string {
  const pub = crypto.createPublicKey(publicPem);
  const der = pub.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('base64url').slice(0, 16);
}

async function loadFromPem(privatePem: string, kidHint?: string): Promise<void> {
  const pkcs8 = pemToPkcs8(privatePem);
  privateKey = await importPKCS8(pkcs8, 'RS256');
  const pub = crypto.createPublicKey(pkcs8);
  const publicPem = pub.export({ type: 'spki', format: 'pem' }).toString();
  keyId = kidHint || computeKidFromPem(publicPem);
  const jwk = await exportJWK(pub);
  publicJwk = { ...jwk, kid: keyId, use: 'sig', alg: 'RS256' } as JWK;
}

function generateAndPersist(): { privatePem: string; kid: string } {
  const { privateKey: priv, publicKey: pub } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const privatePem = priv.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = pub.export({ type: 'spki', format: 'pem' }).toString();
  const kid = computeKidFromPem(publicPem);
  try {
    fs.mkdirSync(PERSIST_DIR, { recursive: true });
    fs.writeFileSync(KEY_FILE, privatePem, { mode: 0o600 });
    fs.writeFileSync(KID_FILE, kid, { mode: 0o644 });
    logger.info({ dir: PERSIST_DIR }, 'OIDC OP signing key persisted');
  } catch (err) {
    logger.warn({ err }, 'Could not persist OIDC OP key — will regenerate on restart');
  }
  return { privatePem, kid };
}

export async function ensureOidcKeys(): Promise<void> {
  if (privateKey) return;

  if (isSamlEnabled() && config.saml) {
    await loadFromPem(config.saml.privateKeyPem);
    logger.info({ kid: keyId }, 'OIDC OP using SAML IdP signing key');
    return;
  }

  if (fs.existsSync(KEY_FILE)) {
    try {
      const privatePem = fs.readFileSync(KEY_FILE, 'utf8');
      const kid = fs.existsSync(KID_FILE) ? fs.readFileSync(KID_FILE, 'utf8').trim() : undefined;
      await loadFromPem(privatePem, kid);
      logger.info({ kid: keyId }, 'OIDC OP signing key loaded from disk');
      return;
    } catch (err) {
      logger.warn({ err }, 'OIDC OP key file unreadable — regenerating');
    }
  }

  const { privatePem, kid } = generateAndPersist();
  await loadFromPem(privatePem, kid);
  logger.info({ kid: keyId }, 'OIDC OP signing key auto-generated');
}

export function getOidcPrivateKey(): KeyLike {
  if (!privateKey) {
    throw new Error('OIDC signing key not initialised — call ensureOidcKeys() at startup');
  }
  return privateKey;
}

export function getOidcKeyId(): string {
  return keyId;
}

export function getOidcJwks(): { keys: JWK[] } {
  if (!publicJwk) {
    throw new Error('OIDC JWKS not initialised');
  }
  return { keys: [publicJwk] };
}
