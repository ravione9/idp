/**
 * SAML launch URL + RelayState helpers.
 */

/** Resolve RelayState: explicit query param wins, then SP default. */
export function resolveSamlRelayState(
  defaultRelayState: string | null | undefined,
  override?: string | null,
): string {
  const fromQuery = (override ?? '').trim();
  if (fromQuery) return fromQuery;
  return (defaultRelayState ?? '').trim();
}

/** Portal launch path; appends RelayState when configured. */
export function samlLaunchPath(slug: string, relayState?: string | null): string {
  const base = `/saml/launch/${encodeURIComponent(slug)}`;
  const rs = (relayState ?? '').trim();
  if (!rs) return base;
  return `${base}?RelayState=${encodeURIComponent(rs)}`;
}
