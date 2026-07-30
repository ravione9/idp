/**
 * IPv4 CIDR / exact / prefix matching for application access IP allowlists.
 */

export function normalizeIp(ip: string): string {
  const trimmed = (ip || '').trim();
  if (trimmed.startsWith('::ffff:')) return trimmed.slice(7);
  return trimmed;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) + v;
  }
  return n >>> 0;
}

/** True when `ip` matches a single allowlist entry (CIDR, exact IP, or trailing-dot prefix). */
export function ipMatchesCidr(ip: string, cidr: string): boolean {
  const client = normalizeIp(ip);
  const rule = (cidr || '').trim();
  if (!client || !rule || client === 'unknown') return false;

  if (rule.includes('/')) {
    const [baseRaw, bitsRaw] = rule.split('/');
    const base = (baseRaw ?? '').trim();
    const bits = Number(bitsRaw);
    const ipInt = ipv4ToInt(client);
    const baseInt = ipv4ToInt(base);
    if (ipInt === null || baseInt === null) return false;
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    if (bits === 0) return true;
    const mask = bits === 32 ? 0xffffffff : (~0 << (32 - bits)) >>> 0;
    return (ipInt & mask) === (baseInt & mask);
  }

  if (rule.endsWith('.')) {
    return client.startsWith(rule);
  }

  return client === normalizeIp(rule);
}

/**
 * Empty / null allowlist = unrestricted.
 * Otherwise the client IP must match at least one entry.
 */
export function ipInAllowlist(ip: string, allowlist: string[] | null | undefined): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  return allowlist.some((entry) => ipMatchesCidr(ip, entry));
}

export function parseCidrList(raw: unknown): string[] {
  if (raw == null) return [];
  let arr: unknown[] = [];
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) arr = parsed;
      else arr = trimmed.split(/[\n,]+/);
    } catch {
      arr = trimmed.split(/[\n,]+/);
    }
  } else {
    return [];
  }
  return arr
    .map((v) => String(v ?? '').trim())
    .filter((v) => v.length > 0)
    .slice(0, 64);
}
