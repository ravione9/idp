/**
 * Admin Central — SAML application (Service Provider) management
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../auth/middleware.js';
import { requireRole } from '../auth/rbac.js';
import { config, isSamlEnabled } from '../config.js';
import { execute, query } from '../db/connection.js';
import logger from '../utils/logger.js';
import { parseSpMetadataXml } from '../saml/parse-sp-metadata.js';

const router = Router();

router.use(requireAuth, requireRole('SUPER_ADMIN'));

const registerSpSchema = z.object({
  name:            z.string().min(1).max(100),
  slug:            z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
  entityId:        z.string().min(1).max(512),
  acsUrl:          z.string().url(),
  sloUrl:          z.string().url().optional(),
  nameidFormat:    z.string().optional(),
  iconUrl:         z.string().url().optional(),
  sortOrder:       z.number().int().optional(),
  entitlementRule: z.object({
    all_active:       z.boolean().optional(),
    roles:            z.array(z.string()).optional(),
    employment_types: z.array(z.string()).optional(),
    dept_ids:         z.array(z.string()).optional(),
    deny_ilg_states:  z.array(z.string()).optional(),
  }).optional(),
});

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
    `SELECT id, name, slug, entity_id, acs_url, slo_url, active, sort_order, icon_url, created_at
       FROM saml_service_providers
      ORDER BY sort_order ASC, name ASC`,
    [],
  );
  res.json({ data: rows });
});

// POST / — register a SAML Service Provider
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const parsed = registerSpSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }

  const d = parsed.data;
  const id = uuidv4();

  try {
    await execute(
      `INSERT INTO saml_service_providers
         (id, name, slug, entity_id, acs_url, slo_url, nameid_format,
          attribute_map, entitlement_rule, icon_url, sort_order, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        id,
        d.name,
        d.slug,
        d.entityId,
        d.acsUrl,
        d.sloUrl ?? null,
        d.nameidFormat ?? 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        null,
        JSON.stringify(d.entitlementRule ?? { all_active: true }),
        d.iconUrl ?? null,
        d.sortOrder ?? 0,
      ],
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

  const updateSchema = z.object({
    name:     z.string().min(1).max(100).optional(),
    slug:     z.string().min(1).max(50).regex(/^[a-z0-9-]+$/).optional(),
    entityId: z.string().min(1).max(512).optional(),
    acsUrl:   z.string().url().optional(),
    sloUrl:   z.string().url().optional().nullable(),
    iconUrl:  z.string().url().optional().nullable(),
    active:   z.boolean().optional(),
  });

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }

  const d = parsed.data;

  try {
    const result = await execute(
      `UPDATE saml_service_providers SET
         name       = COALESCE(?, name),
         slug       = COALESCE(?, slug),
         entity_id  = COALESCE(?, entity_id),
         acs_url    = COALESCE(?, acs_url),
         slo_url    = COALESCE(?, slo_url),
         icon_url   = COALESCE(?, icon_url),
         active     = COALESCE(?, active)
       WHERE id = ?`,
      [
        d.name     ?? null,
        d.slug     ?? null,
        d.entityId ?? null,
        d.acsUrl   ?? null,
        d.sloUrl   !== undefined ? d.sloUrl : null,
        d.iconUrl  !== undefined ? d.iconUrl : null,
        d.active   !== undefined ? (d.active ? 1 : 0) : null,
        id,
      ],
    );

    if (result.affectedRows === 0) {
      res.status(404).json({ error: 'Application not found' });
      return;
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
