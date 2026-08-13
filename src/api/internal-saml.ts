/**
 * LILG — Internal SAML SP registration (admin / automation)
 * Gated by X-Internal-Token.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { execute, query } from '../db/connection.js';
import logger from '../utils/logger.js';
import { timingSafeEqualString } from '../utils/timing-safe.js';
import { enableSamlAppRequestAccess, ensureSamlAppMirrored } from '../services/app-access-policy.js';

const router = Router();

function requireInternalToken(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers['x-internal-token'];
  const token = typeof header === 'string' ? header : '';
  if (!token || !timingSafeEqualString(token, config.app.internalToken)) {
    res.status(403).json({ error: 'Invalid or missing X-Internal-Token' });
    return;
  }
  next();
}

router.use(requireInternalToken);

const registerSpSchema = z.object({
  name:             z.string().min(1).max(100),
  slug:             z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
  entityId:         z.string().min(1).max(512),
  acsUrl:           z.string().url(),
  sloUrl:           z.string().url().optional(),
  defaultRelayState: z.string().max(512).optional().nullable(),
  nameidFormat:     z.string().optional(),
  attributeMap:     z.record(z.string()).optional(),
  entitlementRule:  z.object({
    all_active:       z.boolean().optional(),
    roles:            z.array(z.string()).optional(),
    employment_types: z.array(z.string()).optional(),
    dept_ids:         z.array(z.string()).optional(),
    deny_ilg_states:  z.array(z.string()).optional(),
  }).optional(),
  iconUrl:          z.string().url().optional(),
  sortOrder:        z.number().int().optional(),
});

// ---------------------------------------------------------------------------
// POST / — register a SAML Service Provider
// ---------------------------------------------------------------------------
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const parsed = registerSpSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }

  const d = parsed.data;
  const id = uuidv4();

  await execute(
    `INSERT INTO saml_service_providers
       (id, name, slug, entity_id, acs_url, slo_url, default_relay_state, nameid_format,
        attribute_map, entitlement_rule, icon_url, sort_order, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      id,
      d.name,
      d.slug,
      d.entityId,
      d.acsUrl,
      d.sloUrl ?? null,
      d.defaultRelayState ?? null,
      d.nameidFormat ?? 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      d.attributeMap ? JSON.stringify(d.attributeMap) : null,
      JSON.stringify(d.entitlementRule ?? { all_active: false }),
      d.iconUrl ?? null,
      d.sortOrder ?? 0,
    ],
  );

  await ensureSamlAppMirrored(d.slug).catch((err) =>
    logger.warn({ err, slug: d.slug }, 'Failed to mirror new SAML SP into applications catalog'),
  );

  await enableSamlAppRequestAccess(d.slug, 'internal').catch((err) =>
    logger.warn({ err, slug: d.slug }, 'Failed to enable Request Access for new SAML SP'),
  );

  logger.info({ id, slug: d.slug, entityId: d.entityId }, 'SAML SP registered');
  res.status(201).json({ id, slug: d.slug });
});

// ---------------------------------------------------------------------------
// GET / — list all registered SPs
// ---------------------------------------------------------------------------
router.get('/', async (_req: Request, res: Response): Promise<void> => {
  const rows = await query<Record<string, unknown>>(
    `SELECT id, name, slug, entity_id, acs_url, slo_url, active, sort_order, created_at
       FROM saml_service_providers
      ORDER BY sort_order ASC, name ASC`,
    [],
  );
  res.json({ data: rows });
});

export default router;
