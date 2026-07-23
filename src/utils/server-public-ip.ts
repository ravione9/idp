/**
 * Detect the IdP host's own public IP so getClientIp() never mistakes it
 * for the end-user (common when proxy headers are missing/mis-set).
 */
import logger from './logger.js';

let cached: string | null = null;

function normalizeIp(ip: string): string {
  const trimmed = (ip || '').trim();
  if (trimmed.toLowerCase().startsWith('::ffff:')) return trimmed.slice(7);
  return trimmed;
}

export function getCachedServerPublicIp(): string | null {
  if (cached) return cached;
  for (const key of ['SERVER_PUBLIC_IP', 'ORIGIN_PUBLIC_IP', 'EC2_PUBLIC_IPV4']) {
    const v = process.env[key]?.trim();
    if (v) {
      cached = normalizeIp(v);
      return cached;
    }
  }
  return null;
}

/** Call once at process startup (best-effort; never throws). */
export async function warmServerPublicIp(): Promise<void> {
  if (getCachedServerPublicIp()) {
    logger.info({ serverPublicIp: cached }, 'Using SERVER_PUBLIC_IP from environment');
    return;
  }

  try {
    // IMDSv2 token (EC2)
    const tokenCtl = new AbortController();
    const tokenTimer = setTimeout(() => tokenCtl.abort(), 800);
    let token: string | null = null;
    try {
      const tokenRes = await fetch('http://169.254.169.254/latest/api/token', {
        method: 'PUT',
        headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' },
        signal: tokenCtl.signal,
      });
      if (tokenRes.ok) token = await tokenRes.text();
    } finally {
      clearTimeout(tokenTimer);
    }

    const metaCtl = new AbortController();
    const metaTimer = setTimeout(() => metaCtl.abort(), 800);
    try {
      const headers: Record<string, string> = {};
      if (token) headers['X-aws-ec2-metadata-token'] = token;
      const metaRes = await fetch('http://169.254.169.254/latest/meta-data/public-ipv4', {
        headers,
        signal: metaCtl.signal,
      });
      if (metaRes.ok) {
        const ip = normalizeIp(await metaRes.text());
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
          cached = ip;
          process.env['SERVER_PUBLIC_IP'] = ip;
          logger.info({ serverPublicIp: ip }, 'Detected EC2 public IPv4 for client-IP exclusion');
        }
      }
    } finally {
      clearTimeout(metaTimer);
    }
  } catch {
    // Not on EC2 / IMDS disabled — fine.
  }
}
