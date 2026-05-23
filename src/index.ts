/**
 * LILG — Lenskart Identity Lifecycle & Governance
 * API Server Entry Point
 */

import path from 'path';
import express, { Request, Response, NextFunction } from 'express';
import { pinoHttp } from 'pino-http';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config.js';
import logger from './utils/logger.js';
import { closePool } from './db/connection.js';
import { redis as sessionRedis } from './auth/session-store.js';
import { runMigrations } from './db/migrate.js';
import { rateLimit } from './auth/rate-limit.js';

// Routes
import healthRouter   from './api/health.js';
import employeeRouter from './api/employees.js';
import managerRouter  from './api/manager.js';
import internalRouter from './api/internal.js';
import internalSamlRouter from './api/internal-saml.js';
import samlRouter from './api/saml.js';
import appsRouter from './api/apps.js';
import meRouter from './api/me.js';
import adminLocalUsersRouter from './api/admin-local-users.js';
import adminSamlAppsRouter from './api/admin-saml-apps.js';
import adminDashboardRouter from './api/admin-dashboard.js';
import adminAuditRouter from './api/admin-audit.js';
import adminUsersRouter from './api/admin-users.js';
import meActionsRouter from './api/me-actions.js';

// Auth
import {
  googleCallbackHandler,
  zohoCallbackHandler,
  logoutHandler,
  requireAuth,
} from './auth/middleware.js';
import { googleLoginHandler, zohoLoginHandler } from './auth/login-routes.js';
import { localLoginHandler, localLoginMfaVerifyHandler } from './auth/local-auth.js';
import { ensureMasterAdminFromEnv } from './services/local-admin.js';

const WEB_ROOT = path.join(process.cwd(), 'web');

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------
const app = express();

// Trust proxy headers (X-Forwarded-For, X-Real-IP) — required behind ALB/NGINX
app.set('trust proxy', 1);

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
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ---------------------------------------------------------------------------
// Security headers (no helmet dep — manual)
// ---------------------------------------------------------------------------
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-XSS-Protection', '0'); // disabled in favour of CSP
  next();
});

// ---------------------------------------------------------------------------
// Health / readiness (no auth required)
// ---------------------------------------------------------------------------
app.use('/', healthRouter);

// ---------------------------------------------------------------------------
// Auth endpoints
// ---------------------------------------------------------------------------
app.get('/auth/google',          googleLoginHandler);
app.get('/auth/google/callback', (req, res) => { void googleCallbackHandler(req, res); });
app.get('/auth/zoho',            zohoLoginHandler);
app.get('/auth/zoho/callback',   (req, res) => { void zohoCallbackHandler(req, res); });
app.post('/auth/logout',         requireAuth, (req, res) => { void logoutHandler(req, res); });
const loginRateLimiter = rateLimit({
  max:      10,
  windowMs: 60_000,
  keyFn:    (req) => `${req.ip}:${(req.body && req.body.email) || 'unknown'}`,
});
app.post('/auth/local/login',            loginRateLimiter, (req, res) => { void localLoginHandler(req, res); });
app.post('/auth/local/login/mfa-verify', loginRateLimiter, (req, res) => { void localLoginMfaVerifyHandler(req, res); });

// ---------------------------------------------------------------------------
// SAML IdP (enterprise application SSO)
// ---------------------------------------------------------------------------
app.use('/saml', samlRouter);

// ---------------------------------------------------------------------------
// Public API routes (auth required)
// ---------------------------------------------------------------------------
app.use('/api/me',        meRouter);
app.use('/api/me',        meActionsRouter);
app.use('/api/apps',      appsRouter);
app.use('/api/employees', employeeRouter);
app.use('/api/manager',   managerRouter);
app.use('/api/admin/local-users', adminLocalUsersRouter);
app.use('/api/admin/saml-apps', adminSamlAppsRouter);
app.use('/api/admin/dashboard', adminDashboardRouter);
app.use('/api/admin/audit', adminAuditRouter);
app.use('/api/admin/users', adminUsersRouter);

// ---------------------------------------------------------------------------
// Internal routes (internal token gated — no session cookie required)
// ---------------------------------------------------------------------------
app.use('/api/internal',      internalRouter);
app.use('/api/internal/saml', internalSamlRouter);

// ---------------------------------------------------------------------------
// Web UI (login + admin central)
// ---------------------------------------------------------------------------
app.use(express.static(WEB_ROOT));

const spaRoutes = ['/', '/login', '/admin-central'];
for (const r of spaRoutes) {
  app.get(r, (_req: Request, res: Response) => {
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
    await runMigrations();
  } catch (err) {
    logger.fatal({ err }, 'Database migrations failed — refusing to start');
    process.exit(1);
  }

  await sessionRedis.connect();
  logger.info('Redis connected');

  try {
    await ensureMasterAdminFromEnv();
  } catch (err) {
    logger.error({ err }, 'Master admin provisioning failed — local login may not work');
  }

  const server = app.listen(config.app.port, () => {
    logger.info({ port: config.app.port, env: config.app.nodeEnv }, 'LILG API server started');
  });

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');

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

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'Unhandled promise rejection');
    process.exit(1);
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start LILG API server');
  process.exit(1);
});
