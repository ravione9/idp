/** Normalize application catalog slugs (lowercase, hyphens, max 80 chars). */
export function normalizeAppSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

/** Pre-built template ids that must not become the assignable catalog slug. */
export const GENERIC_CATALOG_SLUGS = new Set(['custom-oidc', 'custom-saml']);

/** Catalog slug for an OIDC client — vendor id for integrations, else derived from display name. */
export function resolveOidcCatalogSlug(name: string, catalogSlug?: string | null): string {
  const fromCatalog = catalogSlug ? normalizeAppSlug(catalogSlug) : '';
  if (fromCatalog && !GENERIC_CATALOG_SLUGS.has(fromCatalog)) return fromCatalog;
  return normalizeAppSlug(name);
}
