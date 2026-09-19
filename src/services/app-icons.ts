/**
 * Application icon upload — DB-backed bytes on `applications` (multi-replica safe).
 * Public URL: /api/public/apps/:appId/icon
 */
import { z } from 'zod';
import { execute, queryOne } from '../db/connection.js';
import logger from '../utils/logger.js';

export const UPLOADED_APP_ICON_PREFIX = '/api/public/apps/';

export const MAX_APP_ICON_BYTES = 400 * 1024;

export const ALLOWED_APP_ICON_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

/** http(s) URL or site-relative path (uploaded icons). */
export const iconUrlSchema = z
  .string()
  .max(512)
  .refine(
    (s) => {
      const t = s.trim();
      if (!t) return true;
      if (t.startsWith('/') && !t.startsWith('//')) return true;
      return /^https?:\/\//i.test(t);
    },
    { message: 'Icon must be an http(s) URL or site path' },
  )
  .optional()
  .nullable()
  .transform((v) => {
    if (v == null) return v;
    const t = String(v).trim();
    return t || null;
  });

export const uploadAppIconBodySchema = z.object({
  // data:image/...;base64,... for a 400 KB file is ~550k chars; keep headroom
  imageBase64: z.string().min(32).max(1_200_000),
  mimeType: z.string().max(64).optional(),
  fileName: z.string().max(255).optional(),
});

export function appIconPublicPath(appId: string): string {
  return `${UPLOADED_APP_ICON_PREFIX}${encodeURIComponent(appId)}/icon`;
}

export function appIconPublicUrl(appId: string, cacheBust?: string | number | Date | null): string {
  const path = appIconPublicPath(appId);
  const v = cacheBust == null ? Date.now() : cacheBust;
  const stamp = v instanceof Date ? v.getTime() : v;
  return `${path}?v=${encodeURIComponent(String(stamp))}`;
}

export function isUploadedAppIconUrl(url: string | null | undefined, appId?: string): boolean {
  if (!url) return false;
  const path = String(url).split('?')[0] ?? '';
  if (!path.startsWith(UPLOADED_APP_ICON_PREFIX) || !path.endsWith('/icon')) return false;
  if (appId) return path === appIconPublicPath(appId);
  return true;
}

export function sniffImageMime(buf: Buffer): string | null {
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

export function decodeImageBase64(imageBase64: string): Buffer {
  const rawB64 = imageBase64
    .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')
    .replace(/\s+/g, '');
  return Buffer.from(rawB64, 'base64');
}

async function syncIconUrlToSamlBySlug(slug: string, iconUrl: string | null): Promise<void> {
  await execute(
    `UPDATE saml_service_providers SET icon_url = ? WHERE slug = ?`,
    [iconUrl, slug],
  );
}

let iconColumnsReady: Promise<void> | null = null;

/** Ensure applications.icon_data / icon_mime exist (migration 067 or schema repair). */
export async function ensureAppIconColumns(): Promise<void> {
  if (!iconColumnsReady) {
    iconColumnsReady = (async () => {
      const dataCol = await queryOne<{ c: number }>(
        `SELECT COUNT(*) AS c FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 'applications' AND column_name = 'icon_data'`,
        [],
      );
      if (Number(dataCol?.c ?? 0) === 0) {
        await execute(
          `ALTER TABLE applications
             ADD COLUMN icon_data MEDIUMBLOB NULL COMMENT 'Uploaded app icon bytes (png/jpeg/webp/gif)'`,
          [],
        );
        logger.warn('Added missing applications.icon_data for app icon upload');
      }
      const mimeCol = await queryOne<{ c: number }>(
        `SELECT COUNT(*) AS c FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 'applications' AND column_name = 'icon_mime'`,
        [],
      );
      if (Number(mimeCol?.c ?? 0) === 0) {
        await execute(
          `ALTER TABLE applications
             ADD COLUMN icon_mime VARCHAR(64) NULL COMMENT 'MIME type of icon_data'`,
          [],
        );
        logger.warn('Added missing applications.icon_mime for app icon upload');
      }
    })().catch((err) => {
      iconColumnsReady = null;
      throw err;
    });
  }
  await iconColumnsReady;
}

function isMissingIconColumnError(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? '';
  const msg = err instanceof Error ? err.message : String(err);
  return code === 'ER_BAD_FIELD_ERROR' || /Unknown column ['`]?icon_(?:data|mime)/i.test(msg);
}

/** Persist icon bytes on applications and keep SAML SP icon_url in sync when present. */
export async function storeApplicationIcon(params: {
  appId: string;
  buf: Buffer;
  mime: string;
  updatedBy?: string | null;
}): Promise<{ icon_url: string; bytes: number; mimeType: string }> {
  const { appId, buf, mime } = params;
  const publicUrl = appIconPublicUrl(appId, Date.now());
  const storedPath = appIconPublicPath(appId);

  await ensureAppIconColumns();

  try {
    await execute(
      `UPDATE applications
          SET icon_data = ?, icon_mime = ?, icon_url = ?, updated_at = UTC_TIMESTAMP()
        WHERE id = ?`,
      [buf, mime, storedPath, appId],
    );
  } catch (err) {
    if (isMissingIconColumnError(err)) {
      iconColumnsReady = null;
      await ensureAppIconColumns();
      await execute(
        `UPDATE applications
            SET icon_data = ?, icon_mime = ?, icon_url = ?, updated_at = UTC_TIMESTAMP()
          WHERE id = ?`,
        [buf, mime, storedPath, appId],
      );
    } else {
      throw err;
    }
  }

  const app = await queryOne<{ slug: string }>(
    `SELECT slug FROM applications WHERE id = ? LIMIT 1`,
    [appId],
  );
  if (app?.slug) {
    await syncIconUrlToSamlBySlug(app.slug, storedPath);
  }

  logger.info({
    appId,
    slug: app?.slug,
    bytes: buf.length,
    mime,
    by: params.updatedBy ?? null,
  }, 'Application icon uploaded');

  return { icon_url: publicUrl, bytes: buf.length, mimeType: mime };
}

export async function clearApplicationIcon(params: {
  appId: string;
  updatedBy?: string | null;
}): Promise<{ icon_url: string | null }> {
  await ensureAppIconColumns();

  const row = await queryOne<{ icon_url: string | null; slug: string }>(
    `SELECT icon_url, slug FROM applications WHERE id = ? LIMIT 1`,
    [params.appId],
  );
  if (!row) {
    return { icon_url: null };
  }

  const clearUrl = isUploadedAppIconUrl(row.icon_url, params.appId);
  await execute(
    `UPDATE applications
        SET icon_data = NULL,
            icon_mime = NULL,
            icon_url = IF(?, NULL, icon_url),
            updated_at = UTC_TIMESTAMP()
      WHERE id = ?`,
    [clearUrl ? 1 : 0, params.appId],
  );

  const nextUrl = clearUrl ? null : row.icon_url;
  if (row.slug && clearUrl) {
    await syncIconUrlToSamlBySlug(row.slug, null);
  }

  logger.info({ appId: params.appId, by: params.updatedBy ?? null }, 'Application icon upload removed');
  return { icon_url: nextUrl };
}

/**
 * When admin sets an external icon URL (or clears it), drop stored upload bytes
 * if the URL no longer points at the uploaded path.
 */
export async function reconcileApplicationIconUrl(appId: string, iconUrl: string | null): Promise<void> {
  if (isUploadedAppIconUrl(iconUrl, appId)) return;
  await execute(
    `UPDATE applications
        SET icon_data = NULL, icon_mime = NULL, icon_url = ?, updated_at = UTC_TIMESTAMP()
      WHERE id = ?`,
    [iconUrl, appId],
  );
  const app = await queryOne<{ slug: string }>(
    `SELECT slug FROM applications WHERE id = ? LIMIT 1`,
    [appId],
  );
  if (app?.slug) {
    await syncIconUrlToSamlBySlug(app.slug, iconUrl);
  }
}

export async function resolveAppIdFromSamlSpId(samlSpId: string): Promise<string | null> {
  const sp = await queryOne<{ slug: string }>(
    `SELECT slug FROM saml_service_providers WHERE id = ? LIMIT 1`,
    [samlSpId],
  );
  if (!sp?.slug) return null;
  const app = await queryOne<{ id: string }>(
    `SELECT id FROM applications WHERE slug = ? LIMIT 1`,
    [sp.slug],
  );
  return app?.id ?? null;
}

export async function resolveAppIdFromOidcClientId(oidcClientId: string): Promise<string | null> {
  const row = await queryOne<{ app_id: string | null }>(
    `SELECT app_id FROM oidc_clients WHERE id = ? LIMIT 1`,
    [oidcClientId],
  );
  return row?.app_id ?? null;
}

export async function getApplicationIconRow(appId: string): Promise<{
  icon_data: Buffer | null;
  icon_mime: string | null;
  updated_at: Date | null;
} | null> {
  return queryOne<{
    icon_data: Buffer | null;
    icon_mime: string | null;
    updated_at: Date | null;
  }>(
    `SELECT icon_data, icon_mime, updated_at FROM applications WHERE id = ? LIMIT 1`,
    [appId],
  );
}

/** Parse + validate upload body; throws Error with user-facing message on failure. */
export function parseUploadedIconBuffer(body: unknown): { buf: Buffer; mime: string; fileName?: string } {
  const parsed = uploadAppIconBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new Error('Invalid icon upload payload');
  }
  let buf: Buffer;
  try {
    buf = decodeImageBase64(parsed.data.imageBase64);
  } catch {
    throw new Error('Invalid base64 image data');
  }
  if (!buf.length || buf.length > MAX_APP_ICON_BYTES) {
    throw new Error(`Icon must be between 1 byte and ${Math.floor(MAX_APP_ICON_BYTES / 1024)} KB`);
  }
  const sniffed = sniffImageMime(buf);
  if (!sniffed || !ALLOWED_APP_ICON_MIME.has(sniffed)) {
    throw new Error('Icon must be a PNG, JPEG, WebP, or GIF image');
  }
  const out: { buf: Buffer; mime: string; fileName?: string } = { buf, mime: sniffed };
  if (parsed.data.fileName) out.fileName = parsed.data.fileName;
  return out;
}
