/**
 * Downloadable Chrome/Edge App Discovery extension (.zip) for portal users.
 */
import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../utils/async-handler.js';
import { buildZipStore, zipFingerprint } from '../utils/zip-store.js';

const router = Router();

const EXT_DIR = path.join(process.cwd(), 'web', 'extension', 'app-discovery');
const FILES = ['manifest.json', 'background.js', 'popup.html', 'popup.js', 'README.md'] as const;
const FOLDER = 'lilg-app-discovery-extension';

function buildExtensionZip(): Buffer {
  const entries = FILES.map((name) => {
    const full = path.join(EXT_DIR, name);
    if (!fs.existsSync(full)) {
      throw new Error(`Extension file missing: ${name}`);
    }
    return {
      name: `${FOLDER}/${name}`,
      data: fs.readFileSync(full),
    };
  });
  return buildZipStore(entries);
}

/** GET /extension/app-discovery.zip — signed-in users download the install package. */
router.get(
  '/app-discovery.zip',
  requireAuth,
  asyncHandler(async (_req: Request, res: Response) => {
    const zip = buildExtensionZip();
    const etag = `"${zipFingerprint(zip)}"`;
    if (_req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="lilg-app-discovery-extension.zip"');
    res.setHeader('Content-Length', String(zip.length));
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('ETag', etag);
    res.send(zip);
  }),
);

export default router;
