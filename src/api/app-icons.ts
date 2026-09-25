/**
 * Public application icon bytes — GET /api/public/apps/:appId/icon
 */
import { Router, Request, Response } from 'express';
import { asyncHandler } from '../utils/async-handler.js';
import {
  ALLOWED_APP_ICON_MIME,
  getApplicationIconRow,
  sniffImageMime,
} from '../services/app-icons.js';

export const publicAppIconsRouter = Router();

publicAppIconsRouter.get('/:appId/icon', asyncHandler(async (req: Request, res: Response) => {
  const appId = String(req.params['appId'] || '').trim();
  if (!appId || appId.length > 64) {
    res.status(404).json({ error: 'Icon not found' });
    return;
  }

  const row = await getApplicationIconRow(appId);
  const buf = row?.icon_data ?? null;
  if (!buf || buf.length === 0) {
    res.status(404).json({ error: 'No uploaded icon' });
    return;
  }

  const sniffed = sniffImageMime(buf);
  const mime = (row?.icon_mime && ALLOWED_APP_ICON_MIME.has(row.icon_mime) && row.icon_mime)
    || sniffed
    || 'application/octet-stream';

  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (row?.updated_at) {
    res.setHeader('Last-Modified', new Date(row.updated_at).toUTCString());
  }
  res.end(buf);
}));
