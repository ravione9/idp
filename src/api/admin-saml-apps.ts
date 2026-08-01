/**
 * Admin Central — SAML application (Service Provider) management
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../auth/middleware.js';
import { requireRole, requirePortalModule } from '../auth/rbac.js';
import { config, isSamlEnabled } from '../config.js';
import { execute, query, queryOne } from '../db/connection.js';
import logger from '../utils/logger.js';
import { parseSpMetadataXml } from '../saml/parse-sp-metadata.js';
import {
  DEFAULT_ATTRIBUTE_MAP,
  SAML_MAPPABLE_FIELD_OPTIONS,
  SAML_MAPPABLE_FIELD_SET,
} from '../saml/types.js';
import { enableSamlAppRequestAccess, ensureSamlAppMirrored, enableRequestAccessForAllSamlApps } from '../services/app-access-policy.js';

const router = Router();

router.use(requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), requirePortalModule('applications'));

const attributeMapSchema = z.record(z.string().min(1).max(120), z.string().min(1).max(80)).optional().nullable();

const registerSpSchema = z.object({
  name:            z.string().min(1).max(100),
  slug:            z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
  entityId:        z.string().min(1).max(512),
  acsUrl:          z.string().url(),
  sloUrl:          z.string().url().optional().nullable(),
  nameidFormat:    z.string().min(1).max(120).optional(),
  nameidAttribute: z.string().min(1).max(80).optional().nullable(),
  attributeMap:    attributeMapSchema,
  signAssertions:  z.boolean().optional(),
  signResponse:    z.boolean().optional(),
  mergeDefaultAttrs: z.boolean().optional(),
  iconUrl:         z.string().url().optional().nullable(),
  sortOrder:       z.number().int().optional(),
  /** Critical app — require fresh MFA at SSO launch (when MFA policy critical_app_mfa is on). */
  requireMfa:      z.boolean().optional(),
  entitlementRule: z.object({
    all_active:       z.boolean().optional(),
    roles:            z.array(z.string()).optional(),
    employment_types: z.array(z.string()).optional(),
    dept_ids:         z.array(z.string()).optional(),
    deny_ilg_states:  z.array(z.string()).optional(),
  }).optional(),
});

const updateSpSchema = z.object({
  name:            z.string().min(1).max(100).optional(),
  slug:            z.string().min(1).max(50).regex(/^[a-z0-9-]+$/).optional(),
  entityId:        z.string().min(1).max(512).optional(),
  acsUrl:          z.string().url().optional(),
  sloUrl:          z.string().url().optional().nullable(),
  nameidFormat:    z.string().min(1).max(120).optional(),
  nameidAttribute: z.string().min(1).max(80).optional().nullable(),
  attributeMap:    attributeMapSchema,
  signAssertions:  z.boolean().optional(),
  signResponse:    z.boolean().optional(),
  mergeDefaultAttrs: z.boolean().optional(),
  iconUrl:         z.string().url().optional().nullable(),
  active:          z.boolean().optional(),
  requireMfa:      z.boolean().optional(),
});

function validateAttributeMap(map: Record<string, string> | null | undefined): string | null {
  if (!map) return null;
  for (const [samlName, empField] of Object.entries(map)) {
    if (!samlName.trim()) return 'Attribute map keys must be non-empty SAML attribute names';
    if (!SAML_MAPPABLE_FIELD_SET.has(empField)) {
      return `Unknown employee field "${empField}" for SAML attribute "${samlName}"`;
    }
  }
  return null;
}

function validateNameidAttribute(field: string | null | undefined): string | null {
  if (field === null || field === undefined || field === '') return null;
  if (!SAML_MAPPABLE_FIELD_SET.has(field)) {
    return `Unknown NameID attribute field "${field}"`;
  }
  return null;
}

function parseJsonObject(raw: unknown): Record<string, string> | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, string>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, string>;
      }
    } catch { /* ignore */ }
  }
  return null;
}

function mapAdminRow(row: Record<string, unknown>) {
  return {
    id:                row['id'],
    name:              row['name'],
    slug:              row['slug'],
    entity_id:         row['entity_id'],
    acs_url:           row['acs_url'],
    slo_url:           row['slo_url'] ?? null,
    nameid_format:     row['nameid_format'],
    nameid_attribute:  row['nameid_attribute'] ?? null,
    attribute_map:     parseJsonObject(row['attribute_map']),
    sign_assertions:   row['sign_assertions'] === undefined ? true : Number(row['sign_assertions']) === 1,
    sign_response:     row['sign_response'] === undefined ? true : Number(row['sign_response']) === 1,
    merge_default_attrs: row['merge_default_attrs'] === undefined ? true : Number(row['merge_default_attrs']) === 1,
    icon_url:          row['icon_url'] ?? null,
    active:            Number(row['active']) === 1,
    sort_order:        Number(row['sort_order'] ?? 0),
    created_at:        row['created_at'],
    /** IGA Request Access (JIT) — mirrored applications.requestable + active workflow */
    request_access:    Number(row['app_requestable'] ?? 0) === 1 && Number(row['has_jit_workflow'] ?? 0) === 1,
    app_requestable:   Number(row['app_requestable'] ?? 0) === 1,
    require_mfa:       Number(row['app_require_mfa'] ?? 0) === 1,
  };
}

// GET /status — IdP configuration summary for Admin Central
router.get('/status', (_req: Request, res: Response): void => {
  const base = config.app.publicBaseUrl ?? config.saml?.baseUrl;
  res.json({
    samlEnabled:  isSamlEnabled(),
    publicBaseUrl: base ?? null,
    metadataUrl:  base ? `${base}/saml/metadata` : null,
    entityId:     config.saml?.entityId ?? (base ? `${base}/saml/metadata` : null),
  });
});

// GET /attribute-fields — mappable employee fields + default attribute map
router.get('/attribute-fields', (_req: Request, res: Response): void => {
  res.json({
    fields: SAML_MAPPABLE_FIELD_OPTIONS,
    defaultAttributeMap: DEFAULT_ATTRIBUTE_MAP,
  });
});

const parseMetadataSchema = z.object({
  metadata: z.string().min(10).max(512_000),
});

// POST /parse-metadata — extract SP Entity ID, ACS, SLO from uploaded XML
router.post('/parse-metadata', async (req: Request, res: Response): Promise<void> => {
  const parsed = parseMetadataSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }

  try {
    const result = parseSpMetadataXml(parsed.data.metadata);
    res.json({ success: true, data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, 'SAML SP metadata parse failed');
    res.status(422).json({ success: false, error: msg });
  }
});

// GET / — list all registered SAML applications
router.get('/', async (_req: Request, res: Response): Promise<void> => {
  const rows = await query<Record<string, unknown>>(
    `SELECT sp.id, sp.name, sp.slug, sp.entity_id, sp.acs_url, sp.slo_url, sp.nameid_format,
            sp.nameid_attribute, sp.attribute_map, sp.sign_assertions, sp.sign_response,
            sp.merge_default_attrs, sp.active, sp.sort_order, sp.icon_url, sp.created_at,
            COALESCE(a.requestable, 0) AS app_requestable,
            COALESCE(a.require_mfa, 0) AS app_require_mfa,
            EXISTS (
              SELECT 1 FROM app_group_access_workflows w
               WHERE w.app_id = a.id AND w.active = 1
            ) AS has_jit_workflow
       FROM saml_service_providers sp
       LEFT JOIN applications a ON a.slug = sp.slug
      ORDER BY sp.sort_order ASC, sp.name ASC`,
    [],
  );
  res.json({ data: rows.map(mapAdminRow) });
});

// POST /enable-request-access-all — enable IGA JIT Request Access for every active SAML SP
router.post('/enable-request-access-all', async (req: Request, res: Response): Promise<void> => {
  const actor = req.user?.empId ?? 'system';
  try {
    const result = await enableRequestAccessForAllSamlApps(actor);
    logger.info({ actor, ...result }, 'Enabled Request Access for all SAML apps');
    res.json({ success: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to enable Request Access';
    res.status(500).json({ error: msg });
  }
});

// POST / — register a SAML Service Provider
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const parsed = registerSpSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }

  const d = parsed.data;
  const mapErr = validateAttributeMap(d.attributeMap);
  if (mapErr) {
    res.status(400).json({ error: mapErr });
    return;
  }
  const nameidErr = validateNameidAttribute(d.nameidAttribute);
  if (nameidErr) {
    res.status(400).json({ error: nameidErr });
    return;
  }

  const id = uuidv4();
  const attributeMapJson = d.attributeMap && Object.keys(d.attributeMap).length > 0
    ? JSON.stringify(d.attributeMap)
    : null;

  try {
    await execute(
      `INSERT INTO saml_service_providers
         (id, name, slug, entity_id, acs_url, slo_url, nameid_format,
          attribute_map, sign_assertions, sign_response, nameid_attribute, merge_default_attrs,
          entitlement_rule, icon_url, sort_order, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        id,
        d.name,
        d.slug,
        d.entityId,
        d.acsUrl,
        d.sloUrl ?? null,
        d.nameidFormat ?? 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        attributeMapJson,
        d.signAssertions === false ? 0 : 1,
        d.signResponse === false ? 0 : 1,
        d.nameidAttribute ?? null,
        d.mergeDefaultAttrs === false ? 0 : 1,
        JSON.stringify(d.entitlementRule ?? { all_active: false }),
        d.iconUrl ?? null,
        d.sortOrder ?? 0,
      ],
    );

    await ensureSamlAppMirrored(d.slug).catch((err) =>
      logger.warn({ err, slug: d.slug }, 'Failed to mirror new SAML SP into applications catalog'),
    );

    if (d.requireMfa !== undefined) {
      const { setApplicationRequireMfa } = await import('../services/app-mfa-stepup.js');
      await setApplicationRequireMfa(d.slug, d.requireMfa).catch((err) =>
        logger.warn({ err, slug: d.slug }, 'Failed to set require_mfa on new SAML app'),
      );
    }

    // Enable IGA Request Access (JIT) so the app appears for end-user SSO requests
    const actor = req.user?.empId ?? 'system';
    await enableSamlAppRequestAccess(d.slug, actor).catch((err) =>
      logger.warn({ err, slug: d.slug }, 'Failed to enable Request Access for new SAML SP'),
    );

    logger.info({ id, slug: d.slug }, 'SAML SP registered via Admin Central');
    res.status(201).json({ id, slug: d.slug });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Registration failed';
    if (msg.includes('Duplicate') || msg.includes('uk_')) {
      res.status(409).json({ error: 'An application with this slug or entity ID already exists' });
      return;
    }
    res.status(400).json({ error: msg });
  }
});

// PUT /:id — update application fields
router.put('/:id', async (req: Request, res: Response): Promise<void> => {
  const id = req.params['id'];
  if (!id) {
    res.status(400).json({ error: 'Missing application id' });
    return;
  }

  const parsed = updateSpSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }

  const d = parsed.data;
  if (d.attributeMap !== undefined) {
    const mapErr = validateAttributeMap(d.attributeMap);
    if (mapErr) {
      res.status(400).json({ error: mapErr });
      return;
    }
  }
  if (d.nameidAttribute !== undefined) {
    const nameidErr = validateNameidAttribute(d.nameidAttribute);
    if (nameidErr) {
      res.status(400).json({ error: nameidErr });
      return;
    }
  }

  const attributeMapJson = d.attributeMap === undefined
    ? undefined
    : (d.attributeMap && Object.keys(d.attributeMap).length > 0
      ? JSON.stringify(d.attributeMap)
      : null);

  try {
    const result = await execute(
      `UPDATE saml_service_providers SET
         name                = COALESCE(?, name),
         slug                = COALESCE(?, slug),
         entity_id           = COALESCE(?, entity_id),
         acs_url             = COALESCE(?, acs_url),
         slo_url             = COALESCE(?, slo_url),
         nameid_format       = COALESCE(?, nameid_format),
         nameid_attribute    = COALESCE(?, nameid_attribute),
         attribute_map       = COALESCE(?, attribute_map),
         sign_assertions     = COALESCE(?, sign_assertions),
         sign_response       = COALESCE(?, sign_response),
         merge_default_attrs = COALESCE(?, merge_default_attrs),
         icon_url            = COALESCE(?, icon_url),
         active              = COALESCE(?, active)
       WHERE id = ?`,
      [
        d.name     ?? null,
        d.slug     ?? null,
        d.entityId ?? null,
        d.acsUrl   ?? null,
        d.sloUrl   !== undefined ? d.sloUrl : null,
        d.nameidFormat ?? null,
        d.nameidAttribute !== undefined ? d.nameidAttribute : null,
        attributeMapJson !== undefined ? attributeMapJson : null,
        d.signAssertions !== undefined ? (d.signAssertions ? 1 : 0) : null,
        d.signResponse !== undefined ? (d.signResponse ? 1 : 0) : null,
        d.mergeDefaultAttrs !== undefined ? (d.mergeDefaultAttrs ? 1 : 0) : null,
        d.iconUrl  !== undefined ? d.iconUrl : null,
        d.active   !== undefined ? (d.active ? 1 : 0) : null,
        id,
      ],
    );

    if (result.affectedRows === 0) {
      res.status(404).json({ error: 'Application not found' });
      return;
    }

    // Allow clearing nameid_attribute / attribute_map when explicitly null.
    if (d.nameidAttribute === null) {
      await execute('UPDATE saml_service_providers SET nameid_attribute = NULL WHERE id = ?', [id]);
    }
    if (d.attributeMap === null || (d.attributeMap && Object.keys(d.attributeMap).length === 0)) {
      await execute('UPDATE saml_service_providers SET attribute_map = NULL WHERE id = ?', [id]);
    }

    if (d.requireMfa !== undefined) {
      const slugRow = await queryOne<{ slug: string }>(
        'SELECT slug FROM saml_service_providers WHERE id = ? LIMIT 1',
        [id],
      );
      if (slugRow?.slug) {
        await ensureSamlAppMirrored(slugRow.slug).catch(() => undefined);
        const { setApplicationRequireMfa } = await import('../services/app-mfa-stepup.js');
        await setApplicationRequireMfa(slugRow.slug, d.requireMfa);
      }
    }

    logger.info({ id }, 'SAML SP updated via Admin Central');
    res.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Update failed';
    if (msg.includes('Duplicate') || msg.includes('uk_')) {
      res.status(409).json({ error: 'An application with this slug or entity ID already exists' });
      return;
    }
    res.status(400).json({ error: msg });
  }
});

// POST /:id/enable-request-access — enable IGA JIT for one SAML SP (mirror + workflow + requestable)
router.post('/:id/enable-request-access', async (req: Request, res: Response): Promise<void> => {
  const id = req.params['id'];
  if (!id) {
    res.status(400).json({ error: 'Missing application id' });
    return;
  }

  const sp = await queryOne<{ slug: string }>(
    'SELECT slug FROM saml_service_providers WHERE id = ? LIMIT 1',
    [id],
  );
  if (!sp) {
    res.status(404).json({ error: 'Application not found' });
    return;
  }

  const actor = req.user?.empId ?? 'system';
  try {
    const result = await enableSamlAppRequestAccess(sp.slug, actor);
    logger.info({ id, slug: sp.slug, actor, ...result }, 'Enabled Request Access for SAML SP');
    res.json({ success: true, slug: sp.slug, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to enable Request Access';
    res.status(400).json({ error: msg });
  }
});

// PUT /:id/activate — re-activate application
router.put('/:id/activate', async (req: Request, res: Response): Promise<void> => {
  const id = req.params['id'];
  if (!id) {
    res.status(400).json({ error: 'Missing application id' });
    return;
  }

  const result = await execute(
    'UPDATE saml_service_providers SET active = 1 WHERE id = ?',
    [id],
  );

  if (result.affectedRows === 0) {
    res.status(404).json({ error: 'Application not found' });
    return;
  }

  logger.info({ id }, 'SAML SP activated via Admin Central');
  res.json({ success: true });
});

// DELETE /:id — hard-delete application
router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  const id = req.params['id'];
  if (!id) {
    res.status(400).json({ error: 'Missing application id' });
    return;
  }

  const result = await execute(
    'DELETE FROM saml_service_providers WHERE id = ?',
    [id],
  );

  if (result.affectedRows === 0) {
    res.status(404).json({ error: 'Application not found' });
    return;
  }

  logger.info({ id }, 'SAML SP deleted via Admin Central');
  res.json({ success: true });
});

export default router;
