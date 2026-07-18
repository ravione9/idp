import SftpClient from 'ssh2-sftp-client';
import logger from '../../utils/logger.js';
import { parseCsvToStaging } from './fetcher.js';
import { expandDateTemplate, resolveSftpRemotePath } from './date-template.js';
import type { SftpConfig, StagingRow } from './types.js';

const MAX_RETRIES = 5;

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function resolveRemoteFileFromListing(
  config: SftpConfig,
  listing: Array<{ type: string; name: string; modifyTime: number }>,
): string | null {
  const dir = config.remoteDir?.trim();
  if (!dir) return null;

  const tz = config.timezone ?? 'Asia/Kolkata';
  const rawPattern = config.filePattern?.trim() || '*.csv';
  const pattern = expandDateTemplate(rawPattern, {
    offsetDays: config.dateOffsetDays ?? 0,
    timeZone: tz,
  });
  const re = patternToRegex(pattern);
  const matches = listing
    .filter((f) => f.type === '-' && re.test(f.name))
    .sort((a, b) => b.modifyTime - a.modifyTime);

  return matches[0] ? `${dir.replace(/\/$/, '')}/${matches[0].name}` : null;
}

async function pickRemoteFile(client: SftpClient, config: SftpConfig): Promise<string> {
  const lookback = config.lookbackDays ?? 1;
  const baseOffset = config.dateOffsetDays ?? 0;

  for (let i = 0; i <= lookback; i++) {
    const offset = baseOffset - i;
    const resolved = resolveSftpRemotePath(config, offset);
    if (resolved) {
      const stat = await client.exists(resolved);
      if (stat === '-') {
        logger.info({ remoteFile: resolved, dateOffset: offset }, 'SFTP file resolved by date template');
        return resolved;
      }
    }
  }

  const dir = config.remoteDir?.trim();
  if (dir) {
    const listing = await client.list(dir);
    const picked = resolveRemoteFileFromListing(config, listing);
    if (picked) {
      const stat = await client.exists(picked);
      if (stat === '-') return picked;
    }
  }

  const preview = resolveSftpRemotePath(config, baseOffset);
  throw new Error(
    preview
      ? `SFTP file not found (tried ${lookback + 1} day(s)): ${preview}`
      : 'SFTP remote path could not be resolved — set fileNameTemplate or remotePath',
  );
}

function buildConnectOptions(config: SftpConfig): Record<string, unknown> {
  const opts: Record<string, unknown> = {
    host: config.host,
    port: config.port ?? 22,
    username: config.username,
    readyTimeout: 30_000,
  };
  if (config.privateKey) {
    opts['privateKey'] = config.privateKey;
    if (config.passphrase) opts['passphrase'] = config.passphrase;
  } else if (config.password) {
    opts['password'] = config.password;
  }
  return opts;
}

export interface SftpFetchResult {
  rows: StagingRow[];
  remoteFile: string;
  csvText: string;
}

export async function fetchAttendanceFromSftp(params: {
  sftpConfig: SftpConfig;
  fileMapping: Record<string, string> | null;
}): Promise<SftpFetchResult> {
  const config = params.sftpConfig;
  if (!config.host?.trim()) throw new Error('SFTP host is not configured');
  if (!config.username?.trim()) throw new Error('SFTP username is not configured');
  if (!config.password && !config.privateKey) {
    throw new Error('SFTP password or private key is required');
  }
  if (
    !config.remotePath?.trim()
    && !config.remoteDir?.trim()
    && !config.fileNameTemplate?.trim()
  ) {
    throw new Error('SFTP remoteDir + fileNameTemplate (or remotePath) is required');
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const client = new SftpClient();
    try {
      await client.connect(buildConnectOptions(config) as SftpClient.ConnectOptions);
      const remoteFile = await pickRemoteFile(client, config);

      const buffer = await client.get(remoteFile);
      const csvText = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
      if (!csvText.trim()) throw new Error(`SFTP file is empty: ${remoteFile}`);

      logger.info({ remoteFile, bytes: csvText.length }, 'Attendance SFTP file fetched');
      const rows = parseCsvToStaging(csvText, params.fileMapping);

      if (config.archiveDir?.trim()) {
        const baseName = remoteFile.split('/').pop() ?? 'attendance.csv';
        const archivePath = `${config.archiveDir.replace(/\/$/, '')}/${baseName}`;
        await client.rename(remoteFile, archivePath);
        logger.info({ remoteFile, archivePath }, 'Attendance SFTP file archived');
      } else if (config.deleteAfterFetch) {
        await client.delete(remoteFile);
        logger.info({ remoteFile }, 'Attendance SFTP file deleted after fetch');
      }

      await client.end();
      return { rows, remoteFile, csvText };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      try { await client.end(); } catch { /* ignore */ }
      const delayMs = Math.min(60_000, 1000 * 2 ** attempt);
      logger.warn(
        { attempt: attempt + 1, delayMs, err: lastError.message },
        'Attendance SFTP fetch failed — retrying',
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  throw lastError ?? new Error('SFTP unavailable after retries');
}

export { previewSftpPaths } from './date-template.js';
