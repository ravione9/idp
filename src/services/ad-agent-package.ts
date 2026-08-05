/**
 * Build the downloadable AD connector agent ZIP for Directory Sync admin UI.
 */
import fs from 'fs';
import path from 'path';
import { buildZipStore, zipFingerprint, type ZipEntry } from '../utils/zip-store.js';

const FOLDER = 'lilg-ad-connector';
const AGENT_ROOT = path.join(process.cwd(), 'connectors', 'ad-agent');
const PACKAGE_VERSION = '1.1.0';

const SKIP_DIRS = new Set(['node_modules', '.git']);
const SKIP_FILES = new Set(['config.json']);

function walkDir(dir: string, base = dir): ZipEntry[] {
  const entries: ZipEntry[] = [];
  if (!fs.existsSync(dir)) return entries;

  for (const name of fs.readdirSync(dir)) {
    if (SKIP_FILES.has(name)) continue;
    const full = path.join(dir, name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    const stat = fs.statSync(full);

    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      entries.push(...walkDir(full, base));
      continue;
    }

    entries.push({
      name: `${FOLDER}/${rel}`,
      data: fs.readFileSync(full),
    });
  }
  return entries;
}

/** Collect agent files into a zip buffer. Throws if package root is missing. */
export function buildAdAgentPackageZip(): Buffer {
  if (!fs.existsSync(AGENT_ROOT)) {
    throw new Error('AD agent package source not found (connectors/ad-agent)');
  }

  const readmePath = path.join(AGENT_ROOT, 'README.md');
  if (!fs.existsSync(readmePath)) {
    throw new Error('AD agent README.md missing');
  }

  const entries = walkDir(AGENT_ROOT);
  if (!entries.some((e) => e.name.endsWith('/dist/index.js'))) {
    throw new Error(
      'AD agent dist/ not built — run npm run build in connectors/ad-agent before packaging',
    );
  }

  return buildZipStore(entries);
}

export function adAgentPackageFingerprint(zip: Buffer): string {
  return zipFingerprint(zip);
}

export function adAgentPackageFilename(): string {
  return `lilg-ad-connector-${PACKAGE_VERSION}.zip`;
}
