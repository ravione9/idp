/**
 * Config — PAM API (Resources, Sessions, Credential Vault, System Users)
 * Mounted at /api/admin/pam
 *
 * Privileged Access is not designed yet — all routes return 501.
 */
import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';

const router = Router();
router.use(requireAuth);
router.use((_req, res) => {
  res.status(501).json({
    error: 'Privileged Access (PAM) is not available yet',
    code: 'PAM_NOT_AVAILABLE',
  });
});

export default router;
