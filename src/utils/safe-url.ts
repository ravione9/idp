/**
 * Outbound URL safety — block SSRF to loopback / private / link-local / metadata.
 */
import dns from 'node:dns/promises';
import net from 'node:net';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
]);

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return -1;
  }
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n < 0) return true;
  // 0.0.0.0/8, 10/8, 127/8, 169.254/16, 172.16/12, 192.168/16, 100.64/10, 224+/multicast+reserved
  if ((n & 0xff000000) === 0x00000000) return true;
  if ((n & 0xff000000) === 0x0a000000) return true;
  if ((n & 0xff000000) === 0x7f000000) return true;
  if ((n & 0xffff0000) === 0xa9fe0000) return true;
  if ((n & 0xfff00000) === 0xac100000) return true;
  if ((n & 0xffff0000) === 0xc0a80000) return true;
  if ((n & 0xffc00000) === 0x64400000) return true;
  if ((n & 0xf0000000) >= 0xe0000000) return true;
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // ULA
  if (normalized.startsWith('fe80')) return true; // link-local
  // IPv4-mapped
  if (normalized.startsWith('::ffff:')) {
    const v4 = normalized.slice('::ffff:'.length);
    if (net.isIP(v4) === 4) return isBlockedIpv4(v4);
  }
  return false;
}

export function isBlockedIpAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return isBlockedIpv4(ip);
  if (kind === 6) return isBlockedIpv6(ip);
  return true;
}

/**
 * Validate that a URL is safe for server-side fetch (http/https only, no private targets).
 * Resolves DNS and checks every address.
 */
export async function assertSafeOutboundUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https URLs are allowed');
  }
  if (parsed.username || parsed.password) {
    throw new Error('URLs with embedded credentials are not allowed');
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost')) {
    throw new Error('URL host is not allowed');
  }

  if (net.isIP(host)) {
    if (isBlockedIpAddress(host)) {
      throw new Error('URL resolves to a private or reserved address');
    }
    return parsed;
  }

  let addresses: string[];
  try {
    const results = await dns.lookup(host, { all: true, verbatim: true });
    addresses = results.map((r) => r.address);
  } catch {
    throw new Error('URL host could not be resolved');
  }

  if (!addresses.length || addresses.some(isBlockedIpAddress)) {
    throw new Error('URL resolves to a private or reserved address');
  }

  return parsed;
}
