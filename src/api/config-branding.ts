/**
 * Config — Branding Settings API
 * Mounted at /api/admin/branding
 */
import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { requireRole } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import { queryOne, execute } from '../db/connection.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('ADMIN', 'SUPER_ADMIN'));

const DEFAULTS = {
  id: 1,
  org_name: 'Lenskart',
  logo_url: null,
  favicon_url: null,
  accent_color: '#2563eb',
  login_hero_title: 'Welcome back',
  login_hero_sub: 'Sign in to your Lenskart account',
  login_bg_url: null,
  support_email: null,
  support_url: null,
  tos_url: null,
  privacy_url: null,
  custom_css: null,
};

// GET /
router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const row = await queryOne(`SELECT * FROM branding_settings WHERE id = 1`, []);
  res.json(row ?? DEFAULTS);
}));

// PUT /
router.put('/', asyncHandler(async (req: Request, res: Response) => {
  const {
    org_name, logo_url, favicon_url, accent_color,
    login_hero_title, login_hero_sub, login_bg_url,
    support_email, support_url, tos_url, privacy_url, custom_css,
  } = req.body as Record<string, string | null>;
  const empId = (req as unknown as { user?: { empId?: string } }).user?.empId ?? null;

  await execute(
    `INSERT INTO branding_settings
       (id, org_name, logo_url, favicon_url, accent_color, login_hero_title,
        login_hero_sub, login_bg_url, support_email, support_url, tos_url,
        privacy_url, custom_css, updated_by, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE
       org_name = VALUES(org_name),
       logo_url = VALUES(logo_url),
       favicon_url = VALUES(favicon_url),
       accent_color = VALUES(accent_color),
       login_hero_title = VALUES(login_hero_title),
       login_hero_sub = VALUES(login_hero_sub),
       login_bg_url = VALUES(login_bg_url),
       support_email = VALUES(support_email),
       support_url = VALUES(support_url),
       tos_url = VALUES(tos_url),
       privacy_url = VALUES(privacy_url),
       custom_css = VALUES(custom_css),
       updated_by = VALUES(updated_by),
       updated_at = UTC_TIMESTAMP()`,
    [org_name ?? 'Lenskart', logo_url ?? null, favicon_url ?? null,
     accent_color ?? '#2563eb', login_hero_title ?? 'Welcome back',
     login_hero_sub ?? 'Sign in to your Lenskart account',
     login_bg_url ?? null, support_email ?? null, support_url ?? null,
     tos_url ?? null, privacy_url ?? null, custom_css ?? null, empId],
  );
  res.json({ success: true });
}));

export default router;
