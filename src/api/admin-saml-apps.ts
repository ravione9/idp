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

// DELETE /:id — deactivate application
router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  const id = req.params['id'];
  if (!id) {
    res.status(400).json({ error: 'Missing application id' });
    return;
  }

  const result = await execute(
    'UPDATE saml_service_providers SET active = 0 WHERE id = ?',
    [id],
  );

  if (result.affectedRows === 0) {
    res.status(404).json({ error: 'Application not found' });
    return;
  }

  logger.info({ id }, 'SAML SP deactivated via Admin Central');
  res.json({ success: true });
});

export default router;
