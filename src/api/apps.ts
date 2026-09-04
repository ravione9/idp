/**
 * LILG — User application catalog (SAML + OIDC launcher)
 * All authenticated users see apps they are entitled to (by Access Policy grant).
 * IP allowlists are enforced at SSO launch time, not when listing tiles.
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { isSamlEnabled } from '../config.js';
import { canReceiveSamlAssertion } from '../saml/entitlements.js';
import { samlLaunchPath } from '../saml/launch-url.js';
import { oidcLaunchPath } from '../oidc/launch-url.js';
import { getActiveOidcPortalApps } from '../oidc/portal-apps.js';
import { getActiveServiceProviders, getEmployeeForSaml } from '../saml/sp-registry.js';
import {
  canUserLaunchApp,
  getApplicationAllowedCidrs,
} from '../services/app-access-policy.js';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/apps — SAML + OIDC apps the current user may see (grant-based)
// ---------------------------------------------------------------------------
router.get('/', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const user = req.user!;

  const emp = await getEmployeeForSaml(user.empId);
  if (!emp) {
    res.status(404).json({ error: 'Employee record not found' });
    return;
  }

  const samlEnabled = isSamlEnabled();
  const samlApps = samlEnabled ? await getActiveServiceProviders() : [];
  const oidcApps = await getActiveOidcPortalApps();

  if (!samlEnabled && !oidcApps.length) {
    res.json({ samlEnabled: false, data: [] });
    return;
  }

  const launchChecks = await Promise.all([
    ...samlApps.map(async (sp) => {
      const ok = await canUserLaunchApp(emp, sp.slug, sp.entitlement_rule);
      if (!ok) return null;
      const cidrs = await getApplicationAllowedCidrs(sp.slug);
      return {
        id: sp.id,
        name: sp.name,
        slug: sp.slug,
        iconUrl: sp.icon_url,
        launchUrl: samlLaunchPath(sp.slug, sp.default_relay_state),
        protocol: 'SAML' as const,
        entityId: sp.entity_id,
        ipRestricted: cidrs.length > 0,
      };
    }),
    ...oidcApps.map(async (app) => {
      const ok = await canUserLaunchApp(emp, app.slug, null);
      if (!ok) return null;
      const cidrs = await getApplicationAllowedCidrs(app.slug);
      return {
        id: app.appId,
        name: app.name,
        slug: app.slug,
        iconUrl: app.iconUrl,
        launchUrl: oidcLaunchPath(app.slug),
        protocol: 'OIDC' as const,
        ipRestricted: cidrs.length > 0,
      };
    }),
  ]);

  const entitled = launchChecks.filter((row): row is NonNullable<typeof row> => row !== null);

  res.json({
    samlEnabled,
    ssoAllowed: canReceiveSamlAssertion(emp),
    data: entitled,
  });
});

export default router;
