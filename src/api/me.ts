/**
 * LILG — Current session / user bootstrap (all authenticated users)
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { queryOne } from '../db/connection.js';
import { config, isSamlEnabled } from '../config.js';
import { ROLES } from '../auth/rbac.js';

const router = Router();

router.get('/', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const user = req.user!;

  const emp = await queryOne<Record<string, unknown>>(
    `SELECT emp_id, full_name, email_corp, dept_id, role, employment_type,
            hrms_status, ilg_state, ilg_state_since, manager_emp_id
       FROM employees WHERE emp_id = ?`,
    [user.empId],
  );

  if (!emp) {
    res.status(404).json({ error: 'Employee record not found' });
    return;
  }

  const role = user.role;
  const roleIndex = ROLES.indexOf(role as (typeof ROLES)[number]);
  const base = config.app.publicBaseUrl ?? config.saml?.baseUrl;

  res.json({
    session: {
      sessionId: user.sessionId,
      email:     user.email,
      iss:       user.iss,
      expiresAt: user.expiresAt,
    },
    employee: emp,
    capabilities: {
      samlEnabled:     isSamlEnabled(),
      metadataUrl:     base ? `${base}/saml/metadata` : null,
      canLaunchApps:   isSamlEnabled() && ['ACTIVE', 'REACTIVATED'].includes(emp['ilg_state'] as string),
      canViewTeam:     roleIndex >= ROLES.indexOf('MANAGER'),
      canViewDirectory: roleIndex >= ROLES.indexOf('MANAGER'),
      canAdmin:        roleIndex >= ROLES.indexOf('ADMIN'),
    },
  });
});

export default router;
