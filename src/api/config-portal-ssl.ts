/**
 * Config — Portal SSL & Connection Settings
 * Mounted at /api/admin/portal-ssl
 *
 * Endpoints:
 *   GET    /               → cert metadata + connection flags (key never returned)
 *   POST   /               → upload cert + key PEM, validates and hot-reloads TLS
 *   DELETE /               → remove certificate, disables HTTPS
 *   PUT    /connection     → toggle portal_https_enabled / portal_allow_http
 */
import { Router, Request, Response } from 'express';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { requireAuth } from '../auth/middleware.js';
import { requireRole } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import { queryOne, execute } from '../db/connection.js';
import { reloadTlsContext, updateConnectionFlags } from '../services/portal-tls.js';
import logger from '../utils/logger.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('SUPER_ADMIN'));

// ---------------------------------------------------------------------------
// GET / — cert metadata + connection flags  (private key is never returned)
// ---------------------------------------------------------------------------
router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const row = await queryOne<Record<string, unknown>>(
      `SELECT portal_ssl_cn, portal_ssl_expiry, portal_ssl_sans,
              portal_https_enabled, portal_allow_http,
              CASE WHEN portal_ssl_cert IS NOT NULL AND portal_ssl_cert != ''
                   THEN 1 ELSE 0 END AS has_cert
         FROM general_settings WHERE id = 1`,
      [],
    );
    res.json(row ?? { has_cert: 0, portal_https_enabled: 0, portal_allow_http: 1 });
  }),
);

// ---------------------------------------------------------------------------
// POST / — upload certificate + private key
// ---------------------------------------------------------------------------
router.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const { cert_pem, key_pem, ca_pem } = req.body as {
      cert_pem?: string;
      key_pem?:  string;
      ca_pem?:   string;
    };

    if (!cert_pem || !key_pem) {
      res.status(400).json({ error: 'cert_pem and key_pem are required' });
      return;
    }

    const certTrimmed = cert_pem.trim();
    const keyTrimmed  = key_pem.trim();
    const caTrimmed   = ca_pem?.trim() || null;

    // ── Validate certificate PEM ─────────────────────────────────────────────
    let x509: X509Certificate;
    try {
      x509 = new X509Certificate(certTrimmed);
    } catch {
      res.status(400).json({ error: 'cert_pem is not a valid PEM certificate. Ensure it includes -----BEGIN CERTIFICATE----- / -----END CERTIFICATE----- headers.' });
      return;
    }

    // ── Validate private key PEM ─────────────────────────────────────────────
    if (!keyTrimmed.includes('-----BEGIN') || !keyTrimmed.includes('PRIVATE KEY-----')) {
      res.status(400).json({ error: 'key_pem does not look like a valid PEM private key (missing -----BEGIN ... PRIVATE KEY----- header).' });
      return;
    }
    let keyObject;
    try {
      keyObject = createPrivateKey(keyTrimmed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: `Failed to parse private key: ${msg}` });
      return;
    }

    // ── Verify key matches certificate ───────────────────────────────────────
    try {
      if (!x509.checkPrivateKey(keyObject)) {
        res.status(400).json({ error: 'Private key does not match the certificate. Make sure you are uploading the key that was used to generate the CSR for this certificate.' });
        return;
      }
    } catch (err) {
      // checkPrivateKey can throw on unsupported key types
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: `Key/cert validation error: ${msg}` });
      return;
    }

    // ── Validate CA chain if provided ────────────────────────────────────────
    if (caTrimmed && !caTrimmed.includes('-----BEGIN CERTIFICATE-----')) {
      res.status(400).json({ error: 'ca_pem does not contain a valid PEM certificate.' });
      return;
    }

    // ── Check expiry ─────────────────────────────────────────────────────────
    const expiry = new Date(x509.validTo);
    const now    = new Date();
    if (expiry < now) {
      res.status(400).json({
        error: `Certificate has already expired on ${expiry.toUTCString()}. Upload a valid, unexpired certificate.`,
      });
      return;
    }
    const daysLeft = Math.floor((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    // ── Extract metadata ─────────────────────────────────────────────────────
    const cn   = extractCn(x509.subject) ?? x509.subject;
    const sans = x509.subjectAltName ?? '';

    // ── Persist to DB ────────────────────────────────────────────────────────
    await execute(
      `UPDATE general_settings
          SET portal_ssl_cert   = ?,
              portal_ssl_key    = ?,
              portal_ssl_ca     = ?,
              portal_ssl_cn     = ?,
              portal_ssl_expiry = ?,
              portal_ssl_sans   = ?,
              updated_at        = UTC_TIMESTAMP()
        WHERE id = 1`,
      [certTrimmed, keyTrimmed, caTrimmed, cn, expiry, sans],
    );

    // ── Hot-reload TLS context (no restart needed) ───────────────────────────
    reloadTlsContext(certTrimmed, keyTrimmed, caTrimmed);

    logger.info({ cn, expiry: expiry.toISOString(), daysLeft, hasCa: Boolean(caTrimmed) },
      'Portal SSL certificate uploaded');

    res.json({
      success:  true,
      cn,
      expiry:   expiry.toISOString(),
      daysLeft,
      sans,
      warning:  daysLeft < 30
        ? `Certificate expires in ${daysLeft} days — consider renewing soon.`
        : null,
    });
  }),
);

// ---------------------------------------------------------------------------
// DELETE / — remove certificate and disable HTTPS
// ---------------------------------------------------------------------------
router.delete(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    await execute(
      `UPDATE general_settings
          SET portal_ssl_cert      = NULL,
              portal_ssl_key       = NULL,
              portal_ssl_ca        = NULL,
              portal_ssl_cn        = NULL,
              portal_ssl_expiry    = NULL,
              portal_ssl_sans      = NULL,
              portal_https_enabled = 0,
              updated_at           = UTC_TIMESTAMP()
        WHERE id = 1`,
      [],
    );
    logger.info('Portal SSL certificate removed — HTTPS disabled');
    res.json({ success: true });
  }),
);

// ---------------------------------------------------------------------------
// PUT /connection — toggle HTTPS enabled / allow HTTP
// ---------------------------------------------------------------------------
router.put(
  '/connection',
  asyncHandler(async (req: Request, res: Response) => {
    const { portal_https_enabled, portal_allow_http } = req.body as {
      portal_https_enabled?: boolean;
      portal_allow_http?:    boolean;
    };

    // ── Guard: can't enable HTTPS without a cert ─────────────────────────────
    if (portal_https_enabled === true) {
      const row = await queryOne<{ has_cert: number }>(
        `SELECT CASE WHEN portal_ssl_cert IS NOT NULL AND portal_ssl_cert != ''
                     THEN 1 ELSE 0 END AS has_cert
           FROM general_settings WHERE id = 1`,
        [],
      );
      if (!row?.has_cert) {
        res.status(400).json({
          error: 'Cannot enable HTTPS without a valid SSL certificate. Upload a certificate first.',
        });
        return;
      }
    }

    // ── Guard: can't disable HTTP while HTTPS is off ─────────────────────────
    if (portal_allow_http === false && portal_https_enabled === false) {
      res.status(400).json({
        error: 'Cannot disable HTTP while HTTPS is also disabled — the portal would become unreachable.',
      });
      return;
    }

    await execute(
      `UPDATE general_settings
          SET portal_https_enabled = COALESCE(?, portal_https_enabled),
              portal_allow_http    = COALESCE(?, portal_allow_http),
              updated_at           = UTC_TIMESTAMP()
        WHERE id = 1`,
      [
        portal_https_enabled !== undefined ? (portal_https_enabled ? 1 : 0) : null,
        portal_allow_http    !== undefined ? (portal_allow_http    ? 1 : 0) : null,
      ],
    );

    // ── Update in-process flags ───────────────────────────────────────────────
    const updated = await queryOne<{ portal_https_enabled: number; portal_allow_http: number }>(
      `SELECT portal_https_enabled, portal_allow_http FROM general_settings WHERE id = 1`,
      [],
    );
    if (updated) {
      updateConnectionFlags(
        Boolean(updated.portal_https_enabled),
        Boolean(updated.portal_allow_http),
      );
    }

    logger.info({ portal_https_enabled, portal_allow_http }, 'Portal connection settings updated');
    res.json({ success: true });
  }),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function extractCn(subject: string): string | null {
  // x509.subject is a newline-separated list of "key=value" pairs
  for (const part of subject.split(/[\n,]+/)) {
    const t = part.trim();
    if (t.startsWith('CN=')) return t.slice(3);
  }
  return null;
}

export default router;
