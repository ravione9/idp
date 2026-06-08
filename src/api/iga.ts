/**
 * IGA + Multi-protocol AM API surface.
 *
 * This is the foundation for the platform vision documented in ARCHITECTURE.md.
 * Read endpoints are wired against the new tables (003_iga_foundation.sql).
 * Write endpoints exist as scaffolds that return 501 NOT_IMPLEMENTED until
 * the corresponding service layer is built.
 *
 * Each domain (applications, connectors, entitlements, access requests,
 * reviews, SoD, risk, reports) is mounted under /api/iga/<domain>.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../auth/middleware.js';
import { requireRole } from '../auth/rbac.js';
import { execute, queryOne } from '../db/connection.js';
import { safeQuery } from '../db/safe-query.js';
import logger from '../utils/logger.js';
import { parseConnectorBoolean, parseConnectorPort } from '../utils/connector-config.js';
import { asyncHandler } from '../utils/async-handler.js';
import { triggerConnectorSync } from '../services/connector-dispatcher.js';
import {
  buildGoogleJwtAuth,
  formatGoogleAuthError,
  listScopedGoogleUsers,
  resolveGoogleSyncScope,
} from '../services/google-directory-config.js';
import { parseGoogleHostedDomains } from '../auth/google-domains.js';
import { google } from 'googleapis';
import { submitAccessRequest, processDecision } from '../services/access-request-workflow.js';
import { createCampaign, submitReviewDecision } from '../services/access-review.js';
import { evaluateSodForGrant } from '../services/sod-evaluator.js';

const router = Router();

// All routes here require an authenticated session. Per-route role checks
// are applied below where stricter access is needed.
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function paginate(req: Request, defaultLimit = 50, maxLimit = 200): { limit: number; offset: number } {
  const limit = Math.min(parseInt((req.query['limit'] as string) ?? String(defaultLimit), 10), maxLimit);
  const offset = parseInt((req.query['offset'] as string) ?? '0', 10);
  return { limit, offset };
}

// ===========================================================================
// /applications — protocol-agnostic application catalog
// ===========================================================================
const appSchema = z.object({
  slug:        z.string().min(1).max(80).regex(/^[a-z0-9-]+$/),
  name:        z.string().min(1).max(150),
  description: z.string().max(2000).optional(),
  iconUrl:     z.string().url().optional(),
  category:    z.string().max(50).optional(),
  ownerEmpId:  z.string().max(20).optional(),
  visibility:  z.enum(['PUBLIC', 'RESTRICTED']).default('PUBLIC'),
  ssoEnabled:  z.boolean().default(true),
  provisioning: z.boolean().default(false),
});

router.get('/applications', asyncHandler(async (req: Request, res: Response) => {
  const { limit, offset } = paginate(req);
  const rows = await safeQuery<Record<string, unknown>>(
    `SELECT a.id, a.slug, a.name, a.description, a.icon_url, a.category,
            a.owner_emp_id, a.visibility, a.sso_enabled, a.provisioning,
            a.risk_score, a.active, a.created_at, a.updated_at,
            (SELECT COUNT(*) FROM app_protocol_configs c WHERE c.app_id = a.id AND c.active = 1) AS protocol_count
       FROM applications a
      ORDER BY a.sort_order ASC, a.name ASC
      LIMIT ? OFFSET ?`,
    [limit, offset],
  );
  res.json({ data: rows, total: rows.length, limit, offset });
}));

router.post(
  '/applications',
  requireRole('SUPER_ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = appSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
      return;
    }
    const id = uuidv4();
    try {
      await execute(
        `INSERT INTO applications
           (id, slug, name, description, icon_url, category, owner_emp_id,
            visibility, sso_enabled, provisioning)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          parsed.data.slug,
          parsed.data.name,
          parsed.data.description ?? null,
          parsed.data.iconUrl ?? null,
          parsed.data.category ?? null,
          parsed.data.ownerEmpId ?? null,
          parsed.data.visibility,
          parsed.data.ssoEnabled ? 1 : 0,
          parsed.data.provisioning ? 1 : 0,
        ],
      );
      logger.info({ id, slug: parsed.data.slug }, 'Application registered');
      res.status(201).json({ id, slug: parsed.data.slug });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Insert failed';
      if (msg.includes('Duplicate')) {
        res.status(409).json({ error: 'Slug already in use' });
        return;
      }
      res.status(400).json({ error: msg });
    }
  }),
);

router.get('/applications/:id', asyncHandler(async (req: Request, res: Response) => {
  const app = await queryOne<Record<string, unknown>>(
    `SELECT * FROM applications WHERE id = ? OR slug = ?`,
    [req.params['id'], req.params['id']],
  );
  if (!app) {
    res.status(404).json({ error: 'Application not found' });
    return;
  }
  const protocols = await safeQuery<Record<string, unknown>>(
    `SELECT id, protocol, active, created_at FROM app_protocol_configs WHERE app_id = ?`,
    [app['id']],
  );
  res.json({ ...app, protocols });
}));

// PUT /applications/:id — update an existing application
router.put(
  '/applications/:id',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const app = await queryOne<{ id: string }>(
      `SELECT id FROM applications WHERE id = ? OR slug = ?`, [id, id],
    );
    if (!app) { res.status(404).json({ error: 'Application not found' }); return; }

    const parsed = appSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
      return;
    }
    const d = parsed.data;
    const setClauses: string[] = [];
    const values: unknown[] = [];
    if (d.name        !== undefined) { setClauses.push('name = ?');        values.push(d.name); }
    if (d.description !== undefined) { setClauses.push('description = ?'); values.push(d.description); }
    if (d.iconUrl     !== undefined) { setClauses.push('icon_url = ?');    values.push(d.iconUrl); }
    if (d.category    !== undefined) { setClauses.push('category = ?');    values.push(d.category); }
    if (d.visibility  !== undefined) { setClauses.push('visibility = ?');  values.push(d.visibility); }
    if (d.ssoEnabled  !== undefined) { setClauses.push('sso_enabled = ?'); values.push(d.ssoEnabled ? 1 : 0); }
    if (d.provisioning!== undefined) { setClauses.push('provisioning = ?');values.push(d.provisioning ? 1 : 0); }
    if ('active' in req.body)         { setClauses.push('active = ?');      values.push(req.body['active'] ? 1 : 0); }
    if (!setClauses.length) { res.json({ updated: false }); return; }
    setClauses.push('updated_at = UTC_TIMESTAMP()');
    values.push(app.id);
    await execute(`UPDATE applications SET ${setClauses.join(', ')} WHERE id = ?`, values);
    logger.info({ id: app.id }, 'Application updated');
    res.json({ updated: true });
  }),
);

// DELETE /applications/:id — remove an application
router.delete(
  '/applications/:id',
  requireRole('SUPER_ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const app = await queryOne<{ id: string }>(
      `SELECT id FROM applications WHERE id = ? OR slug = ?`, [id, id],
    );
    if (!app) { res.status(404).json({ error: 'Application not found' }); return; }
    await execute(`DELETE FROM applications WHERE id = ?`, [app.id]);
    logger.info({ id: app.id }, 'Application deleted');
    res.json({ deleted: true });
  }),
);

// ===========================================================================
// /connectors — pluggable target system adapters
// ===========================================================================
router.get(
  '/connectors',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const { limit, offset } = paginate(req);
    const rows = await safeQuery<Record<string, unknown>>(
      `SELECT id, name, slug, connector_type, direction, sync_mode, sync_schedule,
              status, last_sync_at, last_error, created_at, updated_at
         FROM connectors
        ORDER BY name ASC
        LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    res.json({ data: rows, total: rows.length, limit, offset });
  }),
);

const connectorSchema = z.object({
  name:          z.string().min(1).max(150),
  slug:          z.string().min(1).max(80).regex(/^[a-z0-9-]+$/),
  connectorType: z.string().min(1).max(50),
  direction:     z.enum(['INBOUND', 'OUTBOUND', 'BIDIRECTIONAL']).default('BIDIRECTIONAL'),
  syncMode:      z.enum(['FULL', 'INCREMENTAL', 'RECONCILE']).default('INCREMENTAL'),
  syncSchedule:  z.string().max(100).optional(),
  configJson:    z.record(z.unknown()).optional(),
});

router.post(
  '/connectors',
  requireRole('SUPER_ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = connectorSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
      return;
    }
    const id = uuidv4();
    try {
      await execute(
        `INSERT INTO connectors
           (id, name, slug, connector_type, direction, sync_mode, sync_schedule,
            status, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
        [
          id,
          parsed.data.name,
          parsed.data.slug,
          parsed.data.connectorType,
          parsed.data.direction,
          parsed.data.syncMode,
          parsed.data.syncSchedule ?? null,
          JSON.stringify(parsed.data.configJson ?? {}),
        ],
      );
      logger.info({ id, slug: parsed.data.slug }, 'Connector registered');
      res.status(201).json({ id, slug: parsed.data.slug });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Insert failed';
      if (msg.includes('Duplicate')) {
        res.status(409).json({ error: 'Slug already in use' });
        return;
      }
      res.status(400).json({ error: msg });
    }
  }),
);

router.get(
  '/connectors/:id/runs',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const { limit, offset } = paginate(req);
    const rows = await safeQuery<Record<string, unknown>>(
      `SELECT id, run_type, status, started_at, ended_at,
              items_processed, items_succeeded, items_failed, error_summary
         FROM connector_runs
        WHERE connector_id = ?
        ORDER BY started_at DESC
        LIMIT ? OFFSET ?`,
      [req.params['id'], limit, offset],
    );
    res.json({ data: rows, limit, offset });
  }),
);

router.post(
  '/connectors/:id/sync',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const connectorId = req.params['id']!;
    const triggeredBy = req.user!.empId;
    try {
      const ref = await triggerConnectorSync(connectorId, triggeredBy);
      res.json(ref);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'Connector not found') {
        res.status(404).json({ error: msg });
        return;
      }
      if (msg === 'Connector is not active') {
        res.status(409).json({ error: msg });
        return;
      }
      throw err;
    }
  }),
);

// GET /connectors/:id — get single connector with config
router.get(
  '/connectors/:id',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const row = await queryOne<Record<string, unknown>>(
      `SELECT id, name, slug, connector_type, direction, sync_mode, sync_schedule,
              status, config_json, last_sync_at, last_error, created_at, updated_at
         FROM connectors WHERE id = ?`,
      [req.params['id']],
    );
    if (!row) { res.status(404).json({ error: 'Not found' }); return; }
    // Parse config_json but strip secrets before returning
    try {
      const cfg = typeof row['config_json'] === 'string'
        ? JSON.parse(row['config_json'] as string)
        : (row['config_json'] ?? {});
      // Redact secret fields
      const safe: Record<string, unknown> = { ...cfg };
      for (const k of ['bindPassword', 'password', 'secret', 'apiKey', 'serviceAccountKey', 'clientSecret']) {
        if (k in safe) safe[k] = '••••••••';
      }
      row['config'] = safe;
    } catch { row['config'] = {}; }
    delete row['config_json'];
    res.json(row);
  }),
);

// PUT /connectors/:id — update connector
router.put(
  '/connectors/:id',
  requireRole('SUPER_ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const { name, syncMode, syncSchedule, configJson, status } = req.body as {
      name?: string;
      syncMode?: string;
      syncSchedule?: string;
      configJson?: Record<string, unknown>;
      status?: string;
    };

    // Merge config_json: load existing, patch non-redacted fields
    if (configJson) {
      const existing = await queryOne<{ config_json: string }>(
        `SELECT config_json FROM connectors WHERE id = ?`, [req.params['id']],
      );
      if (!existing) { res.status(404).json({ error: 'Not found' }); return; }
      const rawCfg = existing.config_json;
      const existingCfg: Record<string, unknown> =
        typeof rawCfg === 'string'
          ? JSON.parse(rawCfg || '{}')
          : ((rawCfg as Record<string, unknown>) ?? {});
      const merged: Record<string, unknown> = { ...existingCfg };
      for (const [k, v] of Object.entries(configJson)) {
        // Don't overwrite secret fields with redaction placeholder
        if (typeof v === 'string' && v === '••••••••') continue;
        merged[k] = v;
      }
      await execute(
        `UPDATE connectors SET
           name          = COALESCE(?, name),
           sync_mode     = COALESCE(?, sync_mode),
           sync_schedule = COALESCE(?, sync_schedule),
           status        = COALESCE(?, status),
           config_json   = ?,
           updated_at    = UTC_TIMESTAMP()
         WHERE id = ?`,
        [name ?? null, syncMode ?? null, syncSchedule ?? null, status ?? null,
         JSON.stringify(merged), req.params['id']],
      );
    } else {
      await execute(
        `UPDATE connectors SET
           name          = COALESCE(?, name),
           sync_mode     = COALESCE(?, sync_mode),
           sync_schedule = COALESCE(?, sync_schedule),
           status        = COALESCE(?, status),
           updated_at    = UTC_TIMESTAMP()
         WHERE id = ?`,
        [name ?? null, syncMode ?? null, syncSchedule ?? null, status ?? null, req.params['id']],
      );
    }
    res.json({ success: true });
  }),
);

// DELETE /connectors/:id — remove connector
router.delete(
  '/connectors/:id',
  requireRole('SUPER_ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    await execute(`DELETE FROM connectors WHERE id = ?`, [req.params['id']]);
    res.json({ success: true });
  }),
);

// POST /connectors/:id/test — test connectivity
router.post(
  '/connectors/:id/test',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const row = await queryOne<{ connector_type: string; config_json: string }>(
      `SELECT connector_type, config_json FROM connectors WHERE id = ?`,
      [req.params['id']],
    );
    if (!row) { res.status(404).json({ error: 'Not found' }); return; }
    const type = row.connector_type;

    // Lightweight connectivity check per type
    try {
      // Parse config_json safely — MySQL JSON columns may already be deserialized objects
      const cfg: Record<string, unknown> = typeof row.config_json === 'string'
        ? JSON.parse(row.config_json || '{}')
        : ((row.config_json as Record<string, unknown>) ?? {});

      if (type === 'AD' || type === 'LDAP') {
        const host     = (cfg['host'] as string | undefined)?.trim();
        const useSsl   = parseConnectorBoolean(cfg['useSsl'], false);
        const startTls = parseConnectorBoolean(cfg['startTls'], false);
        const port     = parseConnectorPort(cfg['port'], useSsl ? 636 : 389);
        const bindDn   = (cfg['bindDn'] as string | undefined)?.trim();
        const bindPass = cfg['bindPassword'] as string | undefined;

        // ── Pre-flight: required fields ──────────────────────────────────────
        const missing: string[] = [];
        if (!host)     missing.push('host');
        if (!bindDn)   missing.push('bindDn');
        if (!bindPass) missing.push('bindPassword');
        if (missing.length) {
          res.status(422).json({
            success: false,
            code:    'MISSING_CONFIG',
            message: `Missing required AD/LDAP config field(s): ${missing.join(', ')}. Save the connector with all fields filled in before testing.`,
          });
          return;
        }

        // ── Pre-flight: detect un-saved redaction placeholder ────────────────
        if (bindPass === '••••••••') {
          res.status(422).json({
            success: false,
            code:    'REDACTED_PASSWORD',
            message: 'The bindPassword appears to still be the redaction placeholder. Re-enter the real password and save the connector before testing.',
          });
          return;
        }

        const url = `${useSsl ? 'ldaps' : 'ldap'}://${host}:${port}`;
        const protocol = useSsl ? 'LDAPS' : startTls ? 'LDAP+StartTLS' : 'LDAP';
        logger.info({ url, bindDn, protocol }, 'AD/LDAP connection test starting');

        const { Client: LdapClient } = await import('ldapts');
        // Enterprise AD DCs typically use certificates from an internal CA that is
        // not in Node's trust store, so we skip cert verification for AD connections.
        const tlsOpts = { rejectUnauthorized: false };
        const client = new LdapClient({
          url,
          connectTimeout: 5000,
          tlsOptions: tlsOpts,
        });

        try {
          if (startTls) {
            await client.startTLS(tlsOpts);
          }
          await client.bind(bindDn!, bindPass!);

          const baseDn   = (cfg['baseDn'] as string | undefined)?.trim();
          const targetOuRaw = (cfg['targetOu'] as string | undefined)?.trim() ?? '';
          const { resolveAdDirectoryConfig } = await import('../adapters/ad-adapter.js');
          const warnings: string[] = [];
          const infos: string[] = [];
          let suggestions: string[] = [];

          if (baseDn) {
            try {
              const dir = resolveAdDirectoryConfig(baseDn, targetOuRaw);
              if (dir.inferredProvisionOu) {
                infos.push(
                  `New User OU inferred as ${dir.provisionOuRdn} from Base DN. Recommended: Base DN = ${dir.domainRoot}, New User OU = ${dir.provisionOuRdn}`,
                );
              }
              try {
                await client.search(dir.provisionOuDn, {
                  scope: 'base',
                  filter: '(objectClass=organizationalUnit)',
                  attributes: ['dn'],
                });
              } catch {
                try {
                  const ouResult = await client.search(dir.searchBaseDn, {
                    scope: 'sub',
                    filter: '(objectClass=organizationalUnit)',
                    attributes: ['dn'],
                    sizeLimit: 12,
                  });
                  suggestions = (ouResult.searchEntries as Array<{ dn?: string }>)
                    .map((e) => e.dn ?? '')
                    .filter(Boolean);
                } catch { /* ignore */ }
                const hint = suggestions.length ? ` Existing OUs: ${suggestions.slice(0, 6).join('; ')}` : '';
                warnings.push(`Target OU not found: ${dir.provisionOuDn} — create it in AD or update connector settings.${hint}`);
              }
            } catch (err) {
              warnings.push(err instanceof Error ? err.message : String(err));
            }
          }

          if (!useSsl && !startTls) {
            warnings.push('Protocol is plain LDAP — user provisioning requires LDAPS or LDAP+StartTLS');
          }

          await client.unbind();
          const detail = [...infos, ...warnings].join('; ');
          const msg = detail
            ? `${protocol} bind succeeded${warnings.length ? ', but' : ''}: ${detail}`
            : `${protocol} bind succeeded — connected to ${url} as ${bindDn}`;
          res.status(warnings.length ? 422 : 200).json({
            success: warnings.length === 0,
            message: msg,
            warnings: warnings.length ? warnings : undefined,
            info: infos.length ? infos : undefined,
            ouSuggestions: suggestions.length ? suggestions : undefined,
          });
        } catch (ldapErr) {
          const raw  = ldapErr instanceof Error ? ldapErr.message : String(ldapErr);
          const code = (ldapErr as Record<string, unknown>)['code'];

          // Map well-known LDAP / network errors to actionable messages
          let friendly: string;
          if (typeof code === 'number' && code === 49) {
            friendly = `Invalid credentials (LDAP error 49) — check bindDn and bindPassword. DN used: ${bindDn}`;
          } else if (typeof code === 'number' && code === 8) {
            friendly = `Strong authentication required (LDAP error 8) — this AD server requires encryption. Switch the Protocol to "LDAP + StartTLS (port 389)" or "LDAPS (port 636)" and save before testing.`;
          } else if (typeof code === 'number' && code === 32) {
            friendly = `No Such Object (LDAP error 32) — the bindDn DN was not found in the directory. DN used: ${bindDn}`;
          } else if (raw.includes('ECONNREFUSED')) {
            friendly = `Connection refused — ${url} is not reachable. Check the host, port, and firewall rules.`;
          } else if (raw.includes('ETIMEDOUT') || raw.includes('connectTimeout')) {
            friendly = `Connection timed out reaching ${url}. The host may be unreachable or the port is blocked.`;
          } else if (raw.includes('ENOTFOUND') || raw.includes('getaddrinfo')) {
            friendly = `DNS resolution failed for host "${host}". Verify the hostname is correct and resolvable from this server.`;
          } else if (raw.includes('DEPTH_ZERO_SELF_SIGNED_CERT') || raw.includes('self signed') || raw.includes('unable to verify')) {
            friendly = `TLS certificate error connecting to ${url}. The server's certificate is self-signed or untrusted. Either install the CA cert or set useSsl to false if using plain LDAP.`;
          } else if (raw.includes('ECONNRESET')) {
            friendly = startTls
              ? `Connection was reset during StartTLS handshake on ${url}. The domain controller may have StartTLS disabled. Try switching Protocol to "LDAPS (port 636)" instead.`
              : `Connection was reset by ${url}. If the server requires encryption, switch Protocol to "LDAP + StartTLS (port 389)" or "LDAPS (port 636)".`;
          } else {
            friendly = `LDAP error (${typeof code !== 'undefined' ? `code ${code}` : 'unknown code'}): ${raw}`;
          }

          logger.warn({ url, bindDn, code, raw }, 'AD/LDAP connection test failed');
          res.status(422).json({ success: false, code: `LDAP_${code ?? 'ERROR'}`, message: friendly, detail: raw });
        }
      } else if (type === 'GOOGLE' || type === 'GOOGLE_WORKSPACE') {
        const domains = parseGoogleHostedDomains(cfg['customerDomains'] ?? cfg['customerDomain']);
        const missing: string[] = [];
        if (!domains.length) missing.push('customerDomain');
        if (!String(cfg['adminEmail'] ?? '').trim()) missing.push('adminEmail');
        if (!String(cfg['serviceAccountKey'] ?? '').trim()) {
          missing.push('serviceAccountKey');
        }
        if (missing.length) {
          res.status(422).json({
            success: false,
            code:    'MISSING_CONFIG',
            message: `Missing required Google Workspace config field(s): ${missing.join(', ')}`,
          });
          return;
        }

        try {
          const auth = buildGoogleJwtAuth(cfg);
          const directory = google.admin({ version: 'directory_v1', auth });
          await directory.users.list({ customer: 'my_customer', maxResults: 1 });

          const scope = resolveGoogleSyncScope(cfg);
          const scopedUsers = await listScopedGoogleUsers(directory, scope);
          const scopeParts: string[] = [];
          if (scope.orgUnits.length) scopeParts.push(`${scope.orgUnits.length} OU(s)`);
          if (scope.groups.length) scopeParts.push(`${scope.groups.length} group(s)`);
          if (scope.users.length) scopeParts.push(`${scope.users.length} explicit user(s)`);
          const scopeLabel = scopeParts.length ? scopeParts.join(', ') : 'entire directory';
          const domainLabel = scope.customerDomains.join(', ');
          const notFoundHint = scopedUsers.notFoundEmails.length
            ? ` Not found in Google: ${scopedUsers.notFoundEmails.join(', ')}.`
            : '';

          res.json({
            success: true,
            message: `Connected to Google Workspace (${domainLabel}). Sync scope: ${scopeLabel} — ${scopedUsers.users.length} user(s) matched.${notFoundHint} Portal login allows: ${domainLabel}.`,
          });
        } catch (googleErr) {
          const friendly = formatGoogleAuthError(googleErr, cfg);
          logger.warn({ connectorId: req.params['id'], err: googleErr }, 'Google Workspace connection test failed');
          res.status(422).json({
            success: false,
            code:    'GOOGLE_AUTH_FAILED',
            message: friendly,
            detail:  googleErr instanceof Error ? googleErr.message : String(googleErr),
          });
        }
      } else {
        // Generic: just confirm config is non-empty and connector exists
        res.json({ success: true, message: `Connector "${type}" configuration saved. Full test on next sync.` });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ connectorId: req.params['id'], err }, 'Connector test unexpected error');
      res.status(422).json({ success: false, code: 'UNEXPECTED_ERROR', message: msg });
    }
  }),
);

// ===========================================================================
// /entitlements — granular permissions
// ===========================================================================
router.get(
  '/entitlements',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const { limit, offset } = paginate(req);
    const appId = req.query['appId'] as string | undefined;
    const where: string[] = [];
    const params: unknown[] = [];
    if (appId) { where.push('e.app_id = ?'); params.push(appId); }
    const rows = await safeQuery<Record<string, unknown>>(
      `SELECT e.id, e.app_id, e.connector_id, e.name, e.slug, e.type,
              e.risk_score, e.is_birthright, e.requires_review, e.active, e.created_at,
              a.name AS app_name
         FROM entitlements e
         LEFT JOIN applications a ON a.id = e.app_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY e.name ASC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    res.json({ data: rows, limit, offset });
  }),
);

router.get('/entitlements/me', asyncHandler(async (req: Request, res: Response) => {
  const empId = req.user!.empId;
  const rows = await safeQuery<Record<string, unknown>>(
    `SELECT ue.id, ue.entitlement_id, ue.source, ue.granted_at, ue.expires_at, ue.last_used_at,
            e.name AS entitlement_name, e.type, e.risk_score,
            a.name AS app_name, a.slug AS app_slug, a.icon_url
       FROM user_entitlements ue
       JOIN entitlements e ON e.id = ue.entitlement_id
       LEFT JOIN applications a ON a.id = e.app_id
      WHERE ue.emp_id = ? AND ue.revoked_at IS NULL
      ORDER BY ue.granted_at DESC`,
    [empId],
  );
  res.json({ data: rows });
}));

// ===========================================================================
// /access-requests — request workflow
// ===========================================================================
router.get('/access-requests', asyncHandler(async (req: Request, res: Response) => {
  const empId = req.user!.empId;
  const scope = (req.query['scope'] as string) ?? 'mine';
  const { limit, offset } = paginate(req);

  let where = '';
  const params: unknown[] = [];

  if (scope === 'mine') {
    where = 'WHERE ar.requester_emp_id = ?';
    params.push(empId);
  } else if (scope === 'tasks') {
    where = `WHERE EXISTS (
      SELECT 1 FROM access_request_approvals a
       WHERE a.request_id = ar.id
         AND a.approver_emp_id = ?
         AND a.decision = 'PENDING'
    )`;
    params.push(empId);
  } else if (scope === 'all') {
    if (!['ADMIN', 'SUPER_ADMIN'].includes(req.user!.role)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
  }

  const rows = await safeQuery<Record<string, unknown>>(
    `SELECT ar.id, ar.requester_emp_id, ar.target_emp_id, ar.item_type,
            ar.item_ids, ar.justification, ar.status, ar.created_at,
            ar.decided_at, ar.fulfilled_at, ar.sla_due_at,
            r.full_name AS requester_name, t.full_name AS target_name
       FROM access_requests ar
       LEFT JOIN employees r ON r.emp_id = ar.requester_emp_id
       LEFT JOIN employees t ON t.emp_id = ar.target_emp_id
       ${where}
       ORDER BY ar.created_at DESC
       LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  res.json({ data: rows, limit, offset });
}));

const accessRequestSchema = z.object({
  targetEmpId:   z.string().min(1).max(20),
  itemType:      z.enum(['ENTITLEMENT', 'ROLE', 'APP_ACCESS']),
  itemIds:       z.array(z.string()).min(1),
  justification: z.string().min(1).max(2000),
});

router.post(
  '/access-requests',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = accessRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
      return;
    }
    try {
      const reqId = await submitAccessRequest({
        requesterEmpId: req.user!.empId,
        targetEmpId:    parsed.data.targetEmpId,
        itemType:       parsed.data.itemType,
        itemIds:        parsed.data.itemIds,
        justification:  parsed.data.justification,
      });
      res.status(201).json({ id: reqId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found') || msg.includes('not active')) {
        res.status(404).json({ error: msg });
        return;
      }
      if (msg.includes('SoD')) {
        res.status(422).json({ error: msg, code: 'SOD_VIOLATION' });
        return;
      }
      throw err;
    }
  }),
);

const decisionSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  comment:  z.string().max(2000).optional(),
});

router.post(
  '/access-requests/:id/decision',
  asyncHandler(async (req: Request, res: Response) => {
    const requestId = req.params['id']!;
    const parsed = decisionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
      return;
    }
    try {
      await processDecision(requestId, req.user!.empId, parsed.data.decision, parsed.data.comment);
      res.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) {
        res.status(404).json({ error: msg });
        return;
      }
      if (msg.includes('not in PENDING') || msg.includes('No pending approval')) {
        res.status(409).json({ error: msg });
        return;
      }
      throw err;
    }
  }),
);

// ===========================================================================
// /access-reviews — certification campaigns
// ===========================================================================
router.get(
  '/access-reviews',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const { limit, offset } = paginate(req);
    const rows = await safeQuery<Record<string, unknown>>(
      `SELECT id, name, description, scope, reviewer_kind, start_date, end_date,
              status, created_by, created_at,
              (SELECT COUNT(*) FROM access_review_items i WHERE i.campaign_id = c.id) AS item_count,
              (SELECT COUNT(*) FROM access_review_items i WHERE i.campaign_id = c.id AND i.decision = 'PENDING') AS pending_count
         FROM access_review_campaigns c
        ORDER BY start_date DESC
        LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    res.json({ data: rows, limit, offset });
  }),
);

// GET /access-reviews/:id/items — all items for a campaign (admin)
router.get(
  '/access-reviews/:id/items',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const campaignId = req.params['id']!;
    const rows = await safeQuery<Record<string, unknown>>(
      `SELECT i.id, i.campaign_id, i.emp_id, e.full_name AS subject_name, e.email_corp AS subject_email,
              i.entitlement_id, ent.name AS entitlement_name, ent.app_id,
              i.role_id, br.name AS role_name,
              i.reviewer_emp_id, rev.full_name AS reviewer_name,
              i.decision, i.comment, i.decided_at, i.created_at
         FROM access_review_items i
         LEFT JOIN employees e   ON e.emp_id = i.emp_id
         LEFT JOIN employees rev ON rev.emp_id = i.reviewer_emp_id
         LEFT JOIN entitlements ent ON ent.id = i.entitlement_id
         LEFT JOIN business_roles br ON br.id = i.role_id
        WHERE i.campaign_id = ?
        ORDER BY i.decision ASC, e.full_name ASC`,
      [campaignId],
    );
    res.json({ data: rows });
  }),
);

router.get('/access-reviews/me', asyncHandler(async (req: Request, res: Response) => {
  const empId = req.user!.empId;
  const rows = await safeQuery<Record<string, unknown>>(
    `SELECT i.id, i.campaign_id, c.name AS campaign_name, c.end_date,
            i.emp_id, e.full_name AS subject_name,
            i.entitlement_id, ent.name AS entitlement_name,
            i.role_id, br.name AS role_name,
            i.decision, i.decided_at
       FROM access_review_items i
       JOIN access_review_campaigns c ON c.id = i.campaign_id
       LEFT JOIN employees e   ON e.emp_id = i.emp_id
       LEFT JOIN entitlements ent ON ent.id = i.entitlement_id
       LEFT JOIN business_roles br ON br.id = i.role_id
      WHERE i.reviewer_emp_id = ? AND i.decision = 'PENDING'
        AND c.status = 'ACTIVE'
      ORDER BY c.end_date ASC`,
    [empId],
  );
  res.json({ data: rows });
}));

const campaignSchema = z.object({
  name:         z.string().min(1).max(200),
  description:  z.string().max(2000).optional(),
  scope:        z.enum(['ALL_USERS', 'APP_SPECIFIC', 'ROLE_SPECIFIC', 'HIGH_RISK']),
  reviewerKind: z.enum(['MANAGER', 'APP_OWNER', 'ROLE_OWNER']),
  startDate:    z.string().min(1),
  endDate:      z.string().min(1),
  appId:        z.string().optional(),
  roleId:       z.string().optional(),
});

router.post(
  '/access-reviews',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = campaignSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
      return;
    }
    const campaignParams = {
      name:         parsed.data.name,
      scope:        parsed.data.scope,
      reviewerKind: parsed.data.reviewerKind,
      startDate:    parsed.data.startDate,
      endDate:      parsed.data.endDate,
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      ...(parsed.data.appId !== undefined ? { appId: parsed.data.appId } : {}),
      ...(parsed.data.roleId !== undefined ? { roleId: parsed.data.roleId } : {}),
    };
    const campaignId = await createCampaign(campaignParams, req.user!.empId);
    res.status(201).json({ id: campaignId });
  }),
);

// POST /access-reviews/:id/items/:itemId/decision
const reviewDecisionSchema = z.object({
  decision: z.enum(['CERTIFY', 'REVOKE', 'EXCEPTION']),
  comment:  z.string().max(2000).optional(),
});

router.post(
  '/access-reviews/:id/items/:itemId/decision',
  asyncHandler(async (req: Request, res: Response) => {
    const { itemId } = req.params as { itemId: string };
    const parsed = reviewDecisionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
      return;
    }
    try {
      await submitReviewDecision(itemId, req.user!.empId, parsed.data.decision, parsed.data.comment);
      res.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) {
        res.status(404).json({ error: msg });
        return;
      }
      if (msg.includes('does not match') || msg.includes('already decided')) {
        res.status(409).json({ error: msg });
        return;
      }
      throw err;
    }
  }),
);

// ===========================================================================
// /sod-policies — Segregation of Duties
// ===========================================================================
router.get(
  '/sod-policies',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (_req: Request, res: Response) => {
    const rows = await safeQuery<Record<string, unknown>>(
      `SELECT id, name, description, severity, enforcement, conflict_groups, active, created_at
         FROM sod_policies
        ORDER BY severity DESC, name ASC`,
      [],
    );
    res.json({ data: rows });
  }),
);

router.get(
  '/sod-violations',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const status = (req.query['status'] as string) ?? 'OPEN';
    const rows = await safeQuery<Record<string, unknown>>(
      `SELECT v.id, v.policy_id, p.name AS policy_name, p.severity,
              v.emp_id, e.full_name AS emp_name, e.email_corp,
              v.conflicting_ents, v.detected_at, v.status, v.exception_until
         FROM sod_violations v
         JOIN sod_policies p ON p.id = v.policy_id
         LEFT JOIN employees e ON e.emp_id = v.emp_id
        WHERE v.status = ?
        ORDER BY p.severity DESC, v.detected_at DESC`,
      [status],
    );
    res.json({ data: rows });
  }),
);

// POST /sod-violations/:id/remediate — mark violation as RESOLVED
router.post(
  '/sod-violations/:id/remediate',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const id = req.params['id']!;
    const result = await execute(
      `UPDATE sod_violations SET status='RESOLVED', exception_until=NULL WHERE id=? AND status='OPEN'`,
      [id],
    );
    if ((result as { affectedRows?: number }).affectedRows === 0) {
      res.status(404).json({ error: 'Violation not found or already resolved' });
      return;
    }
    res.json({ success: true });
  }),
);

// ===========================================================================
// /risk — risk scoring
// ===========================================================================
router.get(
  '/risk/dashboard',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (_req: Request, res: Response) => {
    const [topRisk, denied24h, mfa24h] = await Promise.all([
      safeQuery<Record<string, unknown>>(
        `SELECT r.emp_id, e.full_name, e.email_corp, r.score, r.factors, r.updated_at
           FROM risk_scores r
           JOIN employees e ON e.emp_id = r.emp_id
          WHERE r.score >= 50
          ORDER BY r.score DESC
          LIMIT 25`,
        [],
      ),
      queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM login_risk_events
          WHERE decision IN ('DENY','BLOCK')
            AND ts > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)`,
        [],
      ).catch(() => ({ n: 0 })),
      queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM login_risk_events
          WHERE decision = 'MFA'
            AND ts > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)`,
        [],
      ).catch(() => ({ n: 0 })),
    ]);
    res.json({
      topRisk,
      counters: {
        deniedLast24h:    denied24h?.n ?? 0,
        mfaChallengeLast24h: mfa24h?.n ?? 0,
      },
    });
  }),
);

// ===========================================================================
// /reports — compliance reports
// ===========================================================================
router.get(
  '/reports',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (_req: Request, res: Response) => {
    const rows = await safeQuery<Record<string, unknown>>(
      `SELECT id, name, framework, generated_by, generated_at, period_start, period_end, artifact_url
         FROM compliance_reports
        ORDER BY generated_at DESC
        LIMIT 100`,
      [],
    );
    res.json({ data: rows });
  }),
);

const reportSchema = z.object({
  name:        z.string().min(1).max(200),
  framework:   z.string().min(1).max(80),
  periodStart: z.string().min(1),
  periodEnd:   z.string().min(1),
});

router.post(
  '/reports',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = reportSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
      return;
    }
    const id = uuidv4();
    await execute(
      `INSERT INTO compliance_reports
         (id, name, framework, generated_by, generated_at, period_start, period_end)
       VALUES (?, ?, ?, ?, UTC_TIMESTAMP(), ?, ?)`,
      [
        id,
        parsed.data.name,
        parsed.data.framework,
        req.user!.empId,
        parsed.data.periodStart,
        parsed.data.periodEnd,
      ],
    );
    logger.info({ id, framework: parsed.data.framework }, 'Compliance report record created');
    res.status(201).json({
      id,
      hint: 'Report record created. Attach artifact_url via PATCH once the report file is generated.',
    });
  }),
);

// ===========================================================================
// /entitlements/:entId/grant — direct grant with SoD pre-check
// ===========================================================================
const grantSchema = z.object({
  empId:     z.string().min(1).max(20),
  grantedBy: z.string().min(1).max(20).optional(),
});

router.post(
  '/entitlements/:entId/grant',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const { entId } = req.params as { entId: string };
    const parsed = grantSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
      return;
    }

    const { empId, grantedBy } = parsed.data;

    // Verify entitlement exists
    const ent = await queryOne<{ id: string }>(
      'SELECT id FROM entitlements WHERE id = ? AND active = 1',
      [entId],
    );
    if (!ent) {
      res.status(404).json({ error: 'Entitlement not found or inactive' });
      return;
    }

    // SoD pre-check
    const sodResult = await evaluateSodForGrant(empId, entId);
    const blockingViolations = sodResult.violations.filter(
      (v) => v.severity === 'CRITICAL' || v.severity === 'HIGH',
    );
    if (blockingViolations.length > 0) {
      res.status(422).json({
        error:      'SoD policy violation blocks this grant',
        code:       'SOD_VIOLATION',
        violations: blockingViolations,
      });
      return;
    }

    // Grant
    const grantId = uuidv4();
    await execute(
      `INSERT IGNORE INTO user_entitlements
         (id, emp_id, entitlement_id, source, granted_by, granted_at)
       VALUES (?, ?, ?, 'ADMIN_GRANT', ?, UTC_TIMESTAMP())`,
      [grantId, empId, entId, grantedBy ?? req.user!.empId],
    );

    logger.info({ grantId, empId, entId, grantedBy: grantedBy ?? req.user!.empId }, 'Entitlement granted directly');
    res.status(201).json({ id: grantId, empId, entitlementId: entId });
  }),
);

// ===========================================================================
// /sod-policies — CRUD for SoD policy authoring
// ===========================================================================

// POST /sod-policies — create
router.post('/sod-policies', requireRole('SUPER_ADMIN'), asyncHandler(async (req: Request, res: Response) => {
  const { name, description, severity, enforcement, conflict_groups } = req.body as {
    name: string; description?: string; severity?: string;
    enforcement?: string; conflict_groups?: unknown[];
  };
  const id = uuidv4();
  await execute(
    `INSERT INTO sod_policies (id, name, description, severity, enforcement, conflict_groups, active)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [id, name, description ?? null, severity ?? 'MEDIUM', enforcement ?? 'WARN', JSON.stringify(conflict_groups ?? [])],
  );
  res.status(201).json({ id });
}));

// PUT /sod-policies/:id
router.put('/sod-policies/:id', requireRole('SUPER_ADMIN'), asyncHandler(async (req: Request, res: Response) => {
  const { name, description, severity, enforcement, conflict_groups, active } = req.body as {
    name?: string; description?: string; severity?: string;
    enforcement?: string; conflict_groups?: unknown[]; active?: number;
  };
  await execute(
    `UPDATE sod_policies SET name=?, description=?, severity=?, enforcement=?, conflict_groups=?, active=? WHERE id=?`,
    [name, description ?? null, severity, enforcement, JSON.stringify(conflict_groups ?? []), active ? 1 : 0, req.params['id']],
  );
  res.json({ success: true });
}));

// DELETE /sod-policies/:id
router.delete('/sod-policies/:id', requireRole('SUPER_ADMIN'), asyncHandler(async (req: Request, res: Response) => {
  await execute('DELETE FROM sod_policies WHERE id = ?', [req.params['id']]);
  res.json({ success: true });
}));

export default router;
