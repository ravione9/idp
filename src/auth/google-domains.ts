/**
 * Parse and validate Google Workspace hosted domains (multi-domain tenants).
 */

/** Normalize domain: lowercase, no @ prefix, no trailing dot. */
export function normalizeGoogleDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/^@+/, '').replace(/\.+$/, '');
}

/** Parse comma / newline / semicolon separated domain list. */
export function parseGoogleHostedDomains(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return [...new Set(raw.map((v) => normalizeGoogleDomain(String(v))).filter(Boolean))];
  }
  return [...new Set(
    String(raw)
      .split(/[\n,;]+/)
      .map(normalizeGoogleDomain)
      .filter(Boolean),
  )];
}

export function primaryGoogleHostedDomain(domains: string[]): string {
  return domains[0] ?? '';
}

export function emailAllowedForGoogleDomains(email: string, domains: string[]): boolean {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = normalizeGoogleDomain(email.slice(at + 1));
  if (!domain) return false;
  return domains.some((d) => d === domain);
}

export function mergeGoogleHostedDomains(...lists: string[][]): string[] {
  return [...new Set(lists.flat().map(normalizeGoogleDomain).filter(Boolean))];
}
