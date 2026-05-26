/**
 * SAML Auto-Key Bootstrap
 *
 * If SAML_IDP_PRIVATE_KEY_PEM / SAML_IDP_CERT_PEM are not set in the
 * environment, this module generates a fresh RSA-2048 self-signed
 * certificate (3-year validity) using node-forge and injects the PEM
 * strings directly into process.env so the rest of the application
 * sees them as if they had been configured manually.
 *
 * Keys are persisted under SAML_KEY_DIR (default /app/data/saml in Docker)
 * so they survive container restarts — important because SPs pin the IdP certificate fingerprint.
 *
 * Usage: call ensureSamlKeys() once, before config is accessed.
 */

import fs   from 'node:fs';
import path from 'node:path';
import forge from 'node-forge';

const PERSIST_DIR  = process.env['SAML_KEY_DIR'] ?? '/app/data/saml';
const KEY_FILE     = path.join(PERSIST_DIR, '.saml-auto-keys.key');
const CERT_FILE    = path.join(PERSIST_DIR, '.saml-auto-keys.crt');
const VALIDITY_DAYS = 1095; // 3 years

function generateSelfSignedCert(cn: string): { keyPem: string; certPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = Date.now().toString(16);

  const now = new Date();
  const exp = new Date(now);
  exp.setDate(exp.getDate() + VALIDITY_DAYS);

  cert.validity.notBefore = now;
  cert.validity.notAfter  = exp;

  const attrs = [
    { name: 'commonName',         value: cn },
    { name: 'organizationName',   value: 'Lenskart IdP' },
    { name: 'organizationalUnitName', value: 'Identity' },
    { name: 'countryName',        value: 'IN' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);

  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectKeyIdentifier' },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    keyPem:  forge.pki.privateKeyToPem(keys.privateKey),
    certPem: forge.pki.certificateToPem(cert),
  };
}

export function ensureSamlKeys(logger?: { info: (msg: string) => void; warn: (msg: string) => void }): void {
  const log = {
    info: (m: string) => logger ? logger.info(m) : console.info('[saml-auto-keys]', m),
    warn: (m: string) => logger ? logger.warn(m) : console.warn('[saml-auto-keys]', m),
  };

  // Already configured — nothing to do
  if (process.env['SAML_IDP_PRIVATE_KEY_PEM'] && process.env['SAML_IDP_CERT_PEM']) {
    return;
  }

  // Try to load persisted keys from previous run
  if (fs.existsSync(KEY_FILE) && fs.existsSync(CERT_FILE)) {
    try {
      const keyPem  = fs.readFileSync(KEY_FILE,  'utf8').trim();
      const certPem = fs.readFileSync(CERT_FILE, 'utf8').trim();

      // Validate cert is still valid for at least 30 days
      const cert = forge.pki.certificateFromPem(certPem);
      const msLeft = cert.validity.notAfter.getTime() - Date.now();
      const daysLeft = Math.floor(msLeft / 86_400_000);

      if (daysLeft > 30) {
        process.env['SAML_IDP_PRIVATE_KEY_PEM'] = keyPem;
        process.env['SAML_IDP_CERT_PEM']        = certPem;
        if (!process.env['SAML_IDP_BASE_URL']) {
          process.env['SAML_IDP_BASE_URL'] = `http://${process.env['HOST'] ?? '0.0.0.0'}:${process.env['PORT'] ?? '8080'}`;
        }
        log.info(`SAML auto-keys loaded from disk — cert expires in ${daysLeft} days (${cert.validity.notAfter.toISOString().slice(0, 10)})`);
        return;
      }

      log.warn(`SAML auto-cert expires in ${daysLeft} days — regenerating`);
    } catch {
      log.warn('SAML auto-key files unreadable — regenerating');
    }
  }

  // Generate new keys
  log.info('SAML keys not configured — auto-generating RSA-2048 self-signed cert (3 years)…');
  const cn = process.env['SAML_IDP_BASE_URL']
    ? new URL(process.env['SAML_IDP_BASE_URL']).hostname
    : (process.env['HOST'] ?? '192.168.24.254');

  const { keyPem, certPem } = generateSelfSignedCert(cn);

  // Persist so the same cert survives restarts
  try {
    fs.mkdirSync(PERSIST_DIR, { recursive: true });
    fs.writeFileSync(KEY_FILE,  keyPem,  { mode: 0o600 });
    fs.writeFileSync(CERT_FILE, certPem, { mode: 0o644 });
    log.info(`SAML auto-keys persisted to ${PERSIST_DIR}`);
  } catch (e) {
    log.warn(`Could not persist SAML auto-keys (${(e as Error).message}) — they will regenerate on next restart`);
  }

  // Inject into process.env so config.ts picks them up
  process.env['SAML_IDP_PRIVATE_KEY_PEM'] = keyPem;
  process.env['SAML_IDP_CERT_PEM']        = certPem;
  if (!process.env['SAML_IDP_BASE_URL']) {
    const port = process.env['PORT'] ?? '8080';
    process.env['SAML_IDP_BASE_URL'] = `http://192.168.24.254:${port}`;
  }

  // Print fingerprint so admin can pin it in SP configs
  const cert = forge.pki.certificateFromPem(certPem);
  const md = forge.md.sha256.create();
  md.update(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes());
  const fingerprint = md.digest().toHex().match(/.{2}/g)!.join(':').toUpperCase();
  log.info(`SAML auto-cert generated — expires ${cert.validity.notAfter.toISOString().slice(0, 10)} — SHA-256: ${fingerprint}`);
}
