/**
 * Public application icon bytes — GET /api/public/apps/:appId/icon
 */
import { Router, Request, Response } from 'express';
import { asyncHandler } from '../utils/async-handler.js';
import {
  ALLOWED_APP_ICON_MIME,
  getApplicationIconRow,
} from '../services/app-icons.js';

export const publicAppIconsRouter = Router();

publicAppIconsRouter.get('/:appId/icon', asyncHandler(async (req: Request, res: Response) => {
  const appId = String(req.params['appId'] || '').trim();
  if (!appId || appId.length > 64) {
    res.status(404).json({ error: 'Icon not found' });
    return;
  }

  const row = await getApplicationIconRow(appId);
  if (!row?.icon_data || !Buffer.isBuffer(row.icon_data) || row.icon_data.length === 0) {
    res.status(404).json({ error: 'No uploaded icon' });
    return;
  }

  const mime = row.icon_mime && ALLOWED_APP_ICON_MIME.has(row.icon_mime)
    ? row.icon_mime
    : 'application/octet-stream';

  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  if (row.updated_at) {
    res.setHeader('Last-Modified', new Date(row.updated_at).toUTCString());
  }
  res.send(row.icon_data);
}));
