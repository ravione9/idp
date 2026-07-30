/**
 * Parse SAML 2.0 Service Provider metadata XML into registration fields.
 */

import * as saml from 'samlify';

export interface ParsedSpMetadata {
  entityId: string;
  acsUrl: string;
  sloUrl?: string;
  nameidFormat?: string;
}

interface AcsEntry {
  binding?: string;
  location?: string;
  index?: string;
  isDefault?: string | boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(saml as any).setSchemaValidator({ validate: () => true });

const POST_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST';

function pickAcsUrl(acsRaw: unknown): string {
  const entries: AcsEntry[] = Array.isArray(acsRaw)
    ? (acsRaw as AcsEntry[])
    : acsRaw && typeof acsRaw === 'object'
      ? [acsRaw as AcsEntry]
      : [];

  if (!entries.length) {
    throw new Error('No AssertionConsumerService found in SP metadata.');
  }

  const withLocation = entries.filter((e) => String(e.location ?? '').trim());
  if (!withLocation.length) {
    throw new Error('AssertionConsumerService entries have no Location attribute.');
  }

  const post = withLocation.filter((e) => e.binding === POST_BINDING);
  const pool = post.length ? post : withLocation;

  const preferred =
    pool.find((e) => e.isDefault === true || e.isDefault === 'true') ?? pool[0];

  const url = String(preferred.location ?? '').trim();
  if (!url) throw new Error('Could not resolve ACS URL from metadata.');
  return url;
}

function pickSloUrl(sloRaw: unknown): string | undefined {
  const entries: Array<{ binding?: string; location?: string }> = Array.isArray(sloRaw)
    ? sloRaw
    : sloRaw && typeof sloRaw === 'object'
      ? [sloRaw as { binding?: string; location?: string }]
      : [];

  const withLocation = entries
    .map((e) => String(e.location ?? '').trim())
    .filter(Boolean);

  return withLocation[0] || undefined;
}

export function parseSpMetadataXml(xmlRaw: string): ParsedSpMetadata {
  const xml = xmlRaw.trim();
  if (!xml) {
    throw new Error('Metadata XML is empty.');
  }
  if (!xml.includes('EntityDescriptor')) {
    throw new Error('Invalid SAML metadata — expected EntityDescriptor element.');
  }

  const sp = saml.ServiceProvider({ metadata: xml });
  const meta = sp.entityMeta.meta as Record<string, unknown>;

  const entityId = String(meta['entityID'] ?? '').trim();
  if (!entityId) {
    throw new Error('Could not find entityID in SP metadata.');
  }

  const acsUrl = pickAcsUrl(meta['assertionConsumerService']);
  const sloUrl = pickSloUrl(meta['singleLogoutService']);
  const nameidFormat = String(meta['nameIDFormat'] ?? '').trim() || undefined;

  const out: ParsedSpMetadata = { entityId, acsUrl };
  if (sloUrl) out.sloUrl = sloUrl;
  if (nameidFormat) out.nameidFormat = nameidFormat;
  return out;
}
