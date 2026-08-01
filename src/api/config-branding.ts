/**
 * Config — Branding Settings API
 * Mounted at /api/admin/branding
 * Public read: GET /api/public/branding (login page — no auth)
 */
import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { requireRole, requirePortalModule } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import { queryOne, execute } from '../db/connection.js';

const DEFAULTS = {
  id: 1,
  org_name: 'Lenskart',
  logo_url: null as string | null,
  favicon_url: null as string | null,
  accent_color: '#0f4c81',
  login_hero_title: 'Welcome back',
  login_hero_sub: 'Sign in with your work account to continue.',
  login_bg_url: null as string | null,
  support_email: null as string | null,
  support_url: null as string | null,
  tos_url: null as string | null,
  privacy_url: null as string | null,
  custom_css: null as string | null,
};

/** Allow relative site paths or http(s) URLs only (login logo / favicon / bg). */
function safePublicUrl(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim().slice(0, 512);
  if (!s) return null;
  if (s.startsWith('/') && !s.startsWith('//')) return s;
  if (/^https?:\/\//i.test(s)) return s;
  return null;
}

function safeAccent(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) return s;
  return DEFAULTS.accent_color;
}

async function loadBrandingRow(): Promise<Record<string, unknown>> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT org_name, logo_url, favicon_url, accent_color,
            login_hero_title, login_hero_sub, login_bg_url,
            support_email, support_url, tos_url, privacy_url, custom_css
       FROM branding_settings WHERE id = 1`,
    [],
  );
  return row ?? { ...DEFAULTS };
}

/** Public login branding — no secrets; used by /login before session. */
export const publicBrandingRouter = Router();
publicBrandingRouter.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const row = await loadBrandingRow();
  res.json({
    org_name: String(row['org_name'] ?? DEFAULTS.org_name).slice(0, 150) || DEFAULTS.org_name,
    logo_url: safePublicUrl(row['logo_url']),
    favicon_url: safePublicUrl(row['favicon_url']),
    accent_color: safeAccent(row['accent_color']),
    login_hero_title: String(row['login_hero_title'] ?? DEFAULTS.login_hero_title).slice(0, 200),
    login_hero_sub: String(row['login_hero_sub'] ?? DEFAULTS.login_hero_sub).slice(0, 400),
    login_bg_url: safePublicUrl(row['login_bg_url']),
    support_email: row['support_email'] ? String(row['support_email']).slice(0, 150) : null,
    support_url: safePublicUrl(row['support_url']),
    tos_url: safePublicUrl(row['tos_url']),
    privacy_url: safePublicUrl(row['privacy_url']),
    custom_css: row['custom_css'] ? String(row['custom_css']).slice(0, 20_000) : null,
  });
}));

const router = Router();
router.use(requireAuth);
router.use(requireRole('ADMIN', 'SUPER_ADMIN'), requirePortalModule('settings'));

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
     accent_color ?? '#0f4c81', login_hero_title ?? 'Welcome back',
     login_hero_sub ?? 'Sign in with your work account to continue.',
     login_bg_url ?? null, support_email ?? null, support_url ?? null,
     tos_url ?? null, privacy_url ?? null, custom_css ?? null, empId],
  );
  res.json({ success: true });
}));

export default router;
