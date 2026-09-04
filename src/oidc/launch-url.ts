/**
 * OIDC portal launch path (IdP-initiated authorize redirect).
 */

/** Portal launch path for an OIDC-linked application catalog slug. */
export function oidcLaunchPath(slug: string): string {
  return `/oauth/launch/${encodeURIComponent(slug)}`;
}
