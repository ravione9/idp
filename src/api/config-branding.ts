/**
 * Config — Branding Settings API
 * Mounted at /api/admin/branding
 * Public read: GET /api/public/branding (login page — no auth)
 * Public logo: GET /api/public/branding/logo (uploaded image bytes)
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { requireRole, requirePortalModule } from '../auth/rbac.js';
import { asyncHandler } from '../utils/async-handler.js';
import { queryOne, execute } from '../db/connection.js';
import logger from '../utils/logger.js';

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

/** Public path that serves DB-stored logo bytes. */
export const UPLOADED_LOGO_PATH = '/api/public/branding/logo';

const MAX_LOGO_BYTES = 400 * 1024; // stay under global 1mb JSON limit once base64-encoded
const ALLOWED_LOGO_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

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

function sniffLogoMime(buf: Buffer): string | null {
  if (buf.length >= 8
    && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buf.length >= 12
    && buf.toString('ascii', 0, 4) === 'RIFF'
    && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (buf.length >= 6) {
    const head = buf.toString('ascii', 0, 6);
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  }
  return null;
}

function logoPublicUrl(cacheBust?: string | number | Date | null): string {
  const v = cacheBust == null ? Date.now() : cacheBust;
  const stamp = v instanceof Date ? v.getTime() : v;
  return `${UPLOADED_LOGO_PATH}?v=${encodeURIComponent(String(stamp))}`;
}

async function loadBrandingRow(): Promise<Record<string, unknown>> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT org_name, logo_url, favicon_url, accent_color,
            login_hero_title, login_hero_sub, login_bg_url,
            support_email, support_url, tos_url, privacy_url, custom_css,
            CASE WHEN logo_data IS NOT NULL THEN 1 ELSE 0 END AS has_logo_upload,
            updated_at
       FROM branding_settings WHERE id = 1`,
    [],
  );
  return row ?? { ...DEFAULTS, has_logo_upload: 0 };
}

async function ensureBrandingRow(): Promise<void> {
  await execute(
    `INSERT INTO branding_settings (id, org_name, accent_color, login_hero_title, login_hero_sub)
     VALUES (1, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE id = id`,
    [DEFAULTS.org_name, DEFAULTS.accent_color, DEFAULTS.login_hero_title, DEFAULTS.login_hero_sub],
  );
}

/** Public login branding — no secrets; used by /login before session. */
export const publicBrandingRouter = Router();

publicBrandingRouter.get('/logo', asyncHandler(async (_req: Request, res: Response) => {
  const row = await queryOne<{ logo_data: Buffer | null; logo_mime: string | null; updated_at: Date | null }>(
    `SELECT logo_data, logo_mime, updated_at FROM branding_settings WHERE id = 1`,
    [],
  );
  if (!row?.logo_data || !Buffer.isBuffer(row.logo_data) || row.logo_data.length === 0) {
    res.status(404).json({ error: 'No uploaded logo' });
    return;
  }
  const mime = row.logo_mime && ALLOWED_LOGO_MIME.has(row.logo_mime)
    ? row.logo_mime
    : (sniffLogoMime(row.logo_data) || 'application/octet-stream');
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  if (row.updated_at) {
    res.setHeader('ETag', `"logo-${new Date(row.updated_at).getTime()}"`);
  }
  res.send(row.logo_data);
}));

publicBrandingRouter.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const row = await loadBrandingRow();
  let logoUrl = safePublicUrl(row['logo_url']);
  if (Number(row['has_logo_upload']) === 1 && (!logoUrl || logoUrl.startsWith(UPLOADED_LOGO_PATH))) {
    logoUrl = logoPublicUrl(row['updated_at'] as Date | undefined);
  }
  res.json({
    org_name: String(row['org_name'] ?? DEFAULTS.org_name).slice(0, 150) || DEFAULTS.org_name,
    logo_url: logoUrl,
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
    has_logo_upload: Number(row['has_logo_upload']) === 1,
  });
}));

const router = Router();
router.use(requireAuth);
router.use(requireRole('ADMIN', 'SUPER_ADMIN'), requirePortalModule('settings'));

const uploadLogoSchema = z.object({
  imageBase64: z.string().min(1).max(800_000),
  mimeType: z.string().max(64).optional(),
  fileName: z.string().max(200).optional(),
});

// GET / — metadata only (never return logo_data blob)
router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const row = await loadBrandingRow();
  let logoUrl = safePublicUrl(row['logo_url']);
  const hasUpload = Number(row['has_logo_upload']) === 1;
  if (hasUpload && (!logoUrl || logoUrl.startsWith(UPLOADED_LOGO_PATH))) {
    logoUrl = logoPublicUrl(row['updated_at'] as Date | undefined);
  }
  res.json({
    ...DEFAULTS,
    ...row,
    logo_url: logoUrl,
    has_logo_upload: hasUpload,
  });
}));

// PUT /
router.put('/', asyncHandler(async (req: Request, res: Response) => {
  const {
    org_name, logo_url, favicon_url, accent_color,
    login_hero_title, login_hero_sub, login_bg_url,
    support_email, support_url, tos_url, privacy_url, custom_css,
  } = req.body as Record<string, string | null>;
  const empId = (req as unknown as { user?: { empId?: string } }).user?.empId ?? null;

  // Strip cache-buster query from uploaded logo path for storage.
  let safeLogo = safePublicUrl(logo_url);
  if (safeLogo?.startsWith(UPLOADED_LOGO_PATH)) {
    safeLogo = UPLOADED_LOGO_PATH;
  }
  const keepUpload = safeLogo === UPLOADED_LOGO_PATH;

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
    [org_name ?? 'Lenskart', safeLogo, safePublicUrl(favicon_url),
     safeAccent(accent_color), login_hero_title ?? 'Welcome back',
     login_hero_sub ?? 'Sign in with your work account to continue.',
     safePublicUrl(login_bg_url), support_email ?? null, safePublicUrl(support_url),
     safePublicUrl(tos_url), safePublicUrl(privacy_url), custom_css ?? null, empId],
  );

  // Switching to an external URL (or clearing) drops the stored upload bytes.
  if (!keepUpload) {
    await execute(
      `UPDATE branding_settings SET logo_data = NULL, logo_mime = NULL WHERE id = 1`,
      [],
    );
  }

  res.json({ success: true });
}));

// POST /logo — upload image (base64 JSON; no multer dep)
router.post('/logo', asyncHandler(async (req: Request, res: Response) => {
  const parsed = uploadLogoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid logo upload payload' });
    return;
  }

  const rawB64 = parsed.data.imageBase64
    .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')
    .replace(/\s+/g, '');
  let buf: Buffer;
  try {
    buf = Buffer.from(rawB64, 'base64');
  } catch {
    res.status(400).json({ error: 'Invalid base64 image data' });
    return;
  }
  if (!buf.length || buf.length > MAX_LOGO_BYTES) {
    res.status(400).json({
      error: `Logo must be between 1 byte and ${Math.floor(MAX_LOGO_BYTES / 1024)} KB`,
    });
    return;
  }

  const sniffed = sniffLogoMime(buf);
  if (!sniffed || !ALLOWED_LOGO_MIME.has(sniffed)) {
    res.status(400).json({ error: 'Logo must be a PNG, JPEG, WebP, or GIF image' });
    return;
  }
  if (parsed.data.mimeType && parsed.data.mimeType !== sniffed
    && !(parsed.data.mimeType === 'image/jpg' && sniffed === 'image/jpeg')) {
    // Prefer sniffed type; reject obvious mismatches
    if (!ALLOWED_LOGO_MIME.has(parsed.data.mimeType) && parsed.data.mimeType !== 'image/jpg') {
      res.status(400).json({ error: 'Unsupported logo MIME type' });
      return;
    }
  }

  const empId = (req as unknown as { user?: { empId?: string } }).user?.empId ?? null;
  await ensureBrandingRow();
  const publicUrl = logoPublicUrl(Date.now());
  await execute(
    `UPDATE branding_settings
        SET logo_data = ?, logo_mime = ?, logo_url = ?, updated_by = ?, updated_at = UTC_TIMESTAMP()
      WHERE id = 1`,
    [buf, sniffed, publicUrl.split('?')[0], empId],
  );

  logger.info({
    by: empId,
    bytes: buf.length,
    mime: sniffed,
    fileName: parsed.data.fileName,
  }, 'Branding logo uploaded');

  res.json({
    success: true,
    logo_url: publicUrl,
    mimeType: sniffed,
    bytes: buf.length,
    has_logo_upload: true,
  });
}));

// DELETE /logo — remove uploaded logo bytes (and clear logo_url if it pointed at upload)
router.delete('/logo', asyncHandler(async (req: Request, res: Response) => {
  const empId = (req as unknown as { user?: { empId?: string } }).user?.empId ?? null;
  const row = await queryOne<{ logo_url: string | null }>(
    `SELECT logo_url FROM branding_settings WHERE id = 1`,
    [],
  );
  const clearUrl = !row?.logo_url || String(row.logo_url).startsWith(UPLOADED_LOGO_PATH);
  await execute(
    `UPDATE branding_settings
        SET logo_data = NULL,
            logo_mime = NULL,
            logo_url = IF(?, NULL, logo_url),
            updated_by = ?,
            updated_at = UTC_TIMESTAMP()
      WHERE id = 1`,
    [clearUrl ? 1 : 0, empId],
  );
  logger.info({ by: empId }, 'Branding logo upload removed');
  res.json({ success: true, logo_url: clearUrl ? null : row?.logo_url ?? null });
}));

export default router;
