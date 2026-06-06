/**
 * LILG — User application catalog (SAML SP launcher)
 * All authenticated users see apps they are entitled to launch.
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { isSamlEnabled } from '../config.js';
import { canReceiveSamlAssertion } from '../saml/entitlements.js';
import { getActiveServiceProviders, getEmployeeForSaml } from '../saml/sp-registry.js';
import { canUserLaunchApp } from '../services/app-access-policy.js';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/apps — SAML apps the current user may launch
// ---------------------------------------------------------------------------
router.get('/', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const user = req.user!;

  if (!isSamlEnabled()) {
    res.json({ samlEnabled: false, data: [] });
    return;
  }

  const emp = await getEmployeeForSaml(user.empId);
  if (!emp) {
    res.status(404).json({ error: 'Employee record not found' });
    return;
  }

  const allApps = await getActiveServiceProviders();
  const launchChecks = await Promise.all(
    allApps.map(async (sp) => ({
      sp,
      ok: await canUserLaunchApp(emp, sp.slug, sp.entitlement_rule),
    })),
  );
  const entitled = launchChecks.filter((c) => c.ok).map((c) => c.sp);

  res.json({
    samlEnabled: true,
    ssoAllowed:  canReceiveSamlAssertion(emp),
    data: entitled.map((sp) => ({
      id:         sp.id,
      name:       sp.name,
      slug:       sp.slug,
      iconUrl:    sp.icon_url,
      launchUrl:  `/saml/launch/${sp.slug}`,
      entityId:   sp.entity_id,
    })),
  });
});

export default router;
