/**
 * LILG — Lenskart Identity Lifecycle & Governance
 * API Server Entry Point
 */

import path from 'path';
import https from 'node:https';
import express, { Request, Response, NextFunction } from 'express';
import { pinoHttp } from 'pino-http';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config.js';
import { getClientIp, getPublicOrigin, isRequestSecure } from './utils/request-context.js';
import logger from './utils/logger.js';
import { closePool, queryOne } from './db/connection.js';
import { redis as sessionRedis } from './auth/session-store.js';
import { maybeRunBootMigrations } from './db/migrate-boot.js';
import { rateLimit } from './auth/rate-limit.js';
import { registerHttpsServer, getPortalTlsState, buildTlsCertChain } from './services/portal-tls.js';

// Routes
import healthRouter   from './api/health.js';
import employeeRouter from './api/employees.js';
import managerRouter  from './api/manager.js';
import internalRouter from './api/internal.js';
import internalSamlRouter from './api/internal-saml.js';
import samlRouter from './api/saml.js';
import appsRouter from './api/apps.js';
import meRouter from './api/me.js';
import adminLocalUsersRouter, {
  bootstrapAdminHandler,
  bootstrapStatusHandler,
} from './api/admin-local-users.js';
import adminSamlAppsRouter from './api/admin-saml-apps.js';
import adminAppDiscoveryRouter from './api/admin-app-discovery.js';
import extensionDownloadRouter from './api/extension-download.js';
import adminDashboardRouter from './api/admin-dashboard.js';
import adminAuditRouter from './api/admin-audit.js';
import adminUsersRouter from './api/admin-users.js';
import adminBulkUsersRouter from './api/admin-bulk-users.js';
import adminDirectoryGoogleRouter from './api/admin-directory-google.js';
import meActionsRouter from './api/me-actions.js';
import meVaultRouter from './api/me-vault.js';
import igaRouter from './api/iga.js';
import adminLifecycleRouter from './api/admin-lifecycle.js';
import configGroupsRouter from './api/config-groups.js';
import configIdentityProfilesRouter from './api/config-identity-profiles.js';
import configAdaptiveAuthRouter from './api/config-adaptive-auth.js';
import configPasswordPoliciesRouter from './api/config-password-policies.js';
import configBrandingRouter, { publicBrandingRouter } from './api/config-branding.js';
import configGeneralSettingsRouter from './api/config-general-settings.js';
import configOidcClientsRouter from './api/config-oidc-clients.js';
import oidcRouter from './oidc/router.js';
import { ensureOidcKeys } from './oidc/keys.js';
import configPamRouter from './api/config-pam.js';
import configPortalRolesRouter from './api/config-portal-roles.js';
import configWorkflowsRouter from './api/config-workflows.js';
import configTicketsRouter from './api/config-tickets.js';
import configSystemHealthRouter from './api/config-system-health.js';
import configSsoReportsRouter from './api/config-sso-reports.js';
import adminReportsRouter from './api/admin-reports.js';
import configBusinessRolesRouter from './api/config-business-roles.js';
import configBirthrightRouter from './api/config-birthright.js';
import configAppAccessPolicyRouter from './api/config-app-access-policy.js';
import configNotificationsRouter from './api/config-notifications.js';
import configPortalSslRouter from './api/config-portal-ssl.js';
import configAttendanceIgaRouter from './api/config-attendance-iga.js';
import configRadiusRouter from './api/config-radius.js';
import internalRadiusRouter from './api/internal-radius.js';
import internalAdConnectorRouter from './api/internal-ad-connector.js';
import { startRadiusUdpServer } from './services/radius-udp.js';

// Auth
import {
  googleCallbackHandler,
  logoutHandler,
  requireAuth,
  resolveSession,
} from './auth/middleware.js';
import { googleLoginHandler } from './auth/login-routes.js';
import { localLoginHandler, localLoginMfaEnrollConfirmHandler, localLoginMfaEnrollDeferHandler, localLoginMfaEnrollHandler, localLoginMfaSendOtpHandler, localLoginMfaVerifyHandler, localLoginMfaWebAuthnOptionsHandler, localLoginMfaWebAuthnVerifyHandler } from './auth/local-auth.js';
import { sessionMfaChallengeHandler } from './auth/session-mfa-challenge.js';
import { startAttendanceIgaScheduler } from './services/attendance-iga/scheduler.js';
import { startAccessRequestExpiryScheduler } from './services/access-request-expiry.js';
import { startConnectorHealthScheduler } from './services/connector-health.js';
import { startConnectorSyncScheduler } from './services/connector-sync-scheduler.js';
import { reclaimStaleConnectorRuns } from './services/connector-run-lifecycle.js';
import { ensureMasterAdminFromEnv } from './services/local-admin.js';

const WEB_ROOT = path.join(process.cwd(), 'web');

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------
const app = express();

// Trust X-Forwarded-* from Cloudflare WAF / ALB / NGINX (required for req.secure, cookies, OAuth)
app.set('trust proxy', config.app.trustProxy);
// IDP-06 — do not advertise Express via X-Powered-By
app.disable('x-powered-by');

// ---------------------------------------------------------------------------
// Request logging
// ---------------------------------------------------------------------------
app.use(
  pinoHttp({
    logger,
    genReqId: () => uuidv4(),
    customLogLevel: (_req, res) => {
      if (res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    customSuccessMessage: (req, res) =>
      `${req.method} ${req.url} → ${res.statusCode}`,
  }),
);

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------
// AD agent inbound sync posts thousands of users — needs a larger limit than default API routes.
app.use('/api/internal/ad-connector', express.json({ limit: '32mb' }), internalAdConnectorRouter);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ---------------------------------------------------------------------------
// HTTP → HTTPS redirect (when portal_allow_http = 0 and HTTPS is running)
// ---------------------------------------------------------------------------
app.use((req: Request, res: Response, next: NextFunction) => {
  const tls = getPortalTlsState();
  if (tls.httpsEnabled && !tls.allowHttp && !isRequestSecure(req)) {
    const origin = getPublicOrigin(req);
    return res.redirect(301, `${origin}${req.url}`);
  }
  next();
});

// ---------------------------------------------------------------------------
// Security headers (no helmet dep — manual)
// ---------------------------------------------------------------------------
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-XSS-Protection', '0'); // disabled in favour of CSP
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  if (config.app.publicBaseUrl?.startsWith('https://')) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// ---------------------------------------------------------------------------
// ACME HTTP-01 webroot (Let's Encrypt — Cloudflare Full Strict needs CA-signed origin cert)
// ---------------------------------------------------------------------------
const acmeWebroot = process.env['ACME_WEBROOT'];
if (acmeWebroot) {
  app.use('/.well-known/acme-challenge', express.static(acmeWebroot));
}

// ---------------------------------------------------------------------------
// Health / readiness (no auth required)
// ---------------------------------------------------------------------------
app.use('/', healthRouter);

// ---------------------------------------------------------------------------
// Auth endpoints
// ---------------------------------------------------------------------------
app.get('/auth/google',          (req, res) => { void googleLoginHandler(req, res); });
app.get('/auth/google/callback', (req, res) => { void googleCallbackHandler(req, res); });
// Zoho is no longer a portal sign-in method — Zoho Mail is consumed as a
// SAML application via /saml/launch/zoho-mail (see seeded application).
app.get('/auth/zoho',         (_req, res) => res.status(410).json({ error: 'Zoho login deprecated — use Zoho Mail SAML SSO' }));
app.get('/auth/zoho/callback',(_req, res) => res.status(410).json({ error: 'Zoho login deprecated — use Zoho Mail SAML SSO' }));
app.post('/auth/logout',         requireAuth, (req, res) => { void logoutHandler(req, res); });
const loginRateLimiter = rateLimit({
  max:      10,
  windowMs: 60_000,
  keyFn:    (req) => `${getClientIp(req)}:${(req.body && req.body.email) || 'unknown'}`,
});
app.post('/auth/local/login',                    loginRateLimiter, (req, res) => { void localLoginHandler(req, res); });
app.post('/auth/local/login/mfa-verify',         loginRateLimiter, (req, res) => { void localLoginMfaVerifyHandler(req, res); });
app.post('/auth/local/login/mfa-send-otp',      loginRateLimiter, (req, res) => { void localLoginMfaSendOtpHandler(req, res); });
app.post('/auth/local/login/mfa-webauthn/options', loginRateLimiter, (req, res) => { void localLoginMfaWebAuthnOptionsHandler(req, res); });
app.post('/auth/local/login/mfa-webauthn/verify', loginRateLimiter, (req, res) => { void localLoginMfaWebAuthnVerifyHandler(req, res); });
app.post('/auth/local/login/mfa-enroll',         loginRateLimiter, (req, res) => { void localLoginMfaEnrollHandler(req, res); });
app.post('/auth/local/login/mfa-enroll/confirm', loginRateLimiter, (req, res) => { void localLoginMfaEnrollConfirmHandler(req, res); });
app.post('/auth/local/login/mfa-enroll/defer',    loginRateLimiter, (req, res) => { void localLoginMfaEnrollDeferHandler(req, res); });
/** Critical-app MFA step-up for an existing portal session (no password re-entry). */
app.post('/auth/session/mfa-challenge', loginRateLimiter, (req, res) => { void sessionMfaChallengeHandler(req, res); });
// First-time setup (IDP-01) — minimal public surface; not under /api/admin/*
app.get('/auth/local/bootstrap-status', (req, res) => { void bootstrapStatusHandler(req, res); });
app.post('/auth/local/bootstrap', loginRateLimiter, (req, res) => { void bootstrapAdminHandler(req, res); });

// ---------------------------------------------------------------------------
// SAML IdP (enterprise application SSO)
// ---------------------------------------------------------------------------
app.use('/saml', samlRouter);

// ---------------------------------------------------------------------------
// OIDC / OAuth 2.0 Authorization Server (OP)
// Discovery + JWKS + authorize / token / userinfo
// ---------------------------------------------------------------------------
app.use('/', oidcRouter);

// ---------------------------------------------------------------------------
// Public API routes (auth required)
// ---------------------------------------------------------------------------
app.use('/api/me',        meRouter);
app.use('/api/me',        meActionsRouter);
app.use('/api/me',        meVaultRouter);
app.use('/api/apps',      appsRouter);
app.use('/api/employees', employeeRouter);
app.use('/api/manager',   managerRouter);
app.use('/api/admin/local-users', adminLocalUsersRouter);
app.use('/api/admin/saml-apps', adminSamlAppsRouter);
app.use('/api/admin/app-discovery', adminAppDiscoveryRouter);
app.use('/api/admin/dashboard', adminDashboardRouter);
app.use('/api/admin/audit', adminAuditRouter);
app.use('/api/admin/users', adminUsersRouter);
app.use('/api/admin/bulk-users', adminBulkUsersRouter);
app.use('/api/admin/directory/google', adminDirectoryGoogleRouter);
app.use('/api/admin/users', adminLifecycleRouter);
app.use('/api/iga', igaRouter);
app.use('/api/admin/groups', configGroupsRouter);
app.use('/api/admin/identity-profiles', configIdentityProfilesRouter);
app.use('/api/admin/adaptive-auth', configAdaptiveAuthRouter);
app.use('/api/admin/password-policies', configPasswordPoliciesRouter);
app.use('/api/admin/branding', configBrandingRouter);
app.use('/api/public/branding', publicBrandingRouter);
app.use('/api/admin/general-settings', configGeneralSettingsRouter);
app.use('/api/admin/oidc-clients', configOidcClientsRouter);
app.use('/api/admin/pam', configPamRouter);
app.use('/api/admin/portal-roles', configPortalRolesRouter);
app.use('/api/admin/workflows', configWorkflowsRouter);
app.use('/api/admin/tickets', configTicketsRouter);
app.use('/api/admin/system-health', configSystemHealthRouter);
app.use('/api/admin/sso-reports', configSsoReportsRouter);
app.use('/api/admin/reports', adminReportsRouter);
app.use('/api/admin/business-roles', configBusinessRolesRouter);
app.use('/api/admin/birthright', configBirthrightRouter);
app.use('/api/admin/app-access-policy', configAppAccessPolicyRouter);
app.use('/api/admin/notifications', configNotificationsRouter);
app.use('/api/admin/portal-ssl',   configPortalSslRouter);
app.use('/api/admin/attendance-iga', configAttendanceIgaRouter);
app.use('/api/admin/radius', configRadiusRouter);

// ---------------------------------------------------------------------------
// Internal routes (internal token gated — no session cookie required)
// More specific /api/internal/* mounts MUST come before the catch-all internalRouter.
// (ad-connector is mounted above with a larger JSON body limit)
// ---------------------------------------------------------------------------
app.use('/api/internal/saml', internalSamlRouter);
app.use('/api/internal/radius', internalRadiusRouter);
app.use('/api/internal', internalRouter);

// ---------------------------------------------------------------------------
// Portal downloads (authenticated) — before static so .zip is not 404'd
// ---------------------------------------------------------------------------
app.use('/extension', extensionDownloadRouter);

// ---------------------------------------------------------------------------
// Web UI (login + admin central)
// ---------------------------------------------------------------------------
const FAVICON_PATH = path.join(WEB_ROOT, 'favicon.svg');

app.get('/favicon.ico', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.type('image/svg+xml');
  res.sendFile(FAVICON_PATH);
});

app.get('/favicon.svg', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.type('image/svg+xml');
  res.sendFile(FAVICON_PATH);
});

// IDP-04 — admin JS (API surface + admin views) requires a portal session.
const ADMIN_JS = new Set([
  '/js/api-admin.js',
  '/js/views-admin.js',
  '/js/views-stubs.js',
]);
app.get(Array.from(ADMIN_JS), async (req: Request, res: Response, next: NextFunction) => {
  const user = await resolveSession(req, res);
  if (!user) {
    res.status(401).type('text/plain').send('Authentication required');
    return;
  }
  const filePath = path.join(WEB_ROOT, req.path);
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.type('application/javascript');
  res.sendFile(filePath, (err) => {
    if (err) next(err);
  });
});

// Static assets — disable long-lived caching so deployed UI changes show up
// immediately (small SPA, no fingerprinted bundles). ETag still allows 304s.
app.use(
  express.static(WEB_ROOT, {
    etag: false,
    lastModified: true,
    cacheControl: true,
    maxAge: 0,
    setHeaders: (res, filePath) => {
      if (/\.(js|css|html)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('CDN-Cache-Control', 'no-store');
        res.setHeader('Pragma', 'no-cache');
      }
    },
  }),
);

const spaRoutes = ['/', '/login', '/admin-central'];
for (const r of spaRoutes) {
  app.get(r, (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.sendFile(path.join(WEB_ROOT, 'index.html'));
  });
}

// ---------------------------------------------------------------------------
// 404 handler
// ---------------------------------------------------------------------------
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  try {
    await maybeRunBootMigrations(config.app.skipMigrationsOnBoot);
  } catch (err) {
    logger.fatal({ err }, 'Database migrations failed — refusing to start');
    process.exit(1);
  }

  const { warmServerPublicIp } = await import('./utils/server-public-ip.js');
  await warmServerPublicIp();

  await sessionRedis.connect();
  logger.info('Redis connected');

  try {
    await ensureOidcKeys();
    logger.info('OIDC OP signing keys ready');
  } catch (err) {
    logger.error({ err }, 'OIDC OP key bootstrap failed — OIDC issuer will not work');
  }

  try {
    await ensureMasterAdminFromEnv();
  } catch (err) {
    logger.error({ err }, 'Master admin provisioning failed — local login may not work');
  }

  startAttendanceIgaScheduler();
  startAccessRequestExpiryScheduler();
  startConnectorHealthScheduler();
  try {
    const reclaimed = await reclaimStaleConnectorRuns();
    if (reclaimed > 0) {
      logger.warn({ reclaimed }, 'Boot: reclaimed stale connector sync runs');
    }
  } catch (err) {
    logger.error({ err }, 'Boot: failed to reclaim stale connector sync runs');
  }
  startConnectorSyncScheduler();
  startRadiusUdpServer();

  const server = app.listen(config.app.port, () => {
    logger.info({ port: config.app.port, env: config.app.nodeEnv }, 'IDP API server started');
  });

  // ── HTTPS server (if portal SSL cert is stored and enabled in DB) ──────────
  try {
    const sslRow = await queryOne<{
      portal_ssl_cert:      string | null;
      portal_ssl_key:       string | null;
      portal_ssl_ca:        string | null;
      portal_https_enabled: number;
      portal_allow_http:    number;
    }>(
      `SELECT portal_ssl_cert, portal_ssl_key, portal_ssl_ca,
              portal_https_enabled, portal_allow_http
         FROM general_settings WHERE id = 1`,
      [],
    );

    if (sslRow?.portal_https_enabled && sslRow.portal_ssl_cert && sslRow.portal_ssl_key) {
      const httpsPort = parseInt(process.env['HTTPS_PORT'] ?? '8443', 10);
      const httpsServer = https.createServer(
        {
          cert: buildTlsCertChain(sslRow.portal_ssl_cert, sslRow.portal_ssl_ca),
          key:  sslRow.portal_ssl_key,
        },
        app,
      );
      httpsServer.listen(httpsPort, () => {
        logger.info({ port: httpsPort }, 'Portal HTTPS server started');
      });
      registerHttpsServer(httpsServer, httpsPort);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__httpsServer = httpsServer;
    } else {
      logger.info('Portal HTTPS not configured — running HTTP only');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to start HTTPS server — continuing with HTTP only');
  }

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');

    // Close HTTPS server first if running
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const httpsServer = (globalThis as any).__httpsServer as https.Server | undefined;
    if (httpsServer) httpsServer.close(() => logger.info('HTTPS server closed'));

    server.close(async () => {
      logger.info('HTTP server closed');
      await sessionRedis.quit();
      await closePool();
      logger.info('Shutdown complete');
      process.exit(0);
    });

    // Force exit after 30s if graceful shutdown stalls
    setTimeout(() => {
      logger.error('Forced shutdown after 30s timeout');
      process.exit(1);
    }, 30_000).unref();
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT',  () => { void shutdown('SIGINT'); });

  // Uncaught (synchronous) exceptions usually indicate the process state is
  // corrupt — exit so the orchestrator restarts us.
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    process.exit(1);
  });

  // Unhandled promise rejections — log and continue (don't crash on transient DB errors)
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled promise rejection');
  });
}

void main().catch((err) => {
  logger.fatal({ err }, 'Failed to start IDP API server');
  process.exit(1);
});
