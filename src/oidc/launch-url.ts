/**
 * OIDC portal launch path — access-checked proxy before SP-initiated OAuth.
 */

/** Portal launch path for an OIDC-linked application catalog slug. */
export function oidcLaunchPath(slug: string): string {
  return `/oauth/launch/${encodeURIComponent(slug)}`;
}
