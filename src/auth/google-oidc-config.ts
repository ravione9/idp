import { config } from '../config.js';
import { queryOne } from '../db/connection.js';
import {
  mergeGoogleHostedDomains,
  parseGoogleHostedDomains,
  primaryGoogleHostedDomain,
} from './google-domains.js';

type Source = 'env' | 'db' | 'connector';

export interface GoogleOidcConfig {
  clientId: string;
  clientSecret: string;
  /** Primary domain (first in list) — backward compatible. */
  hostedDomain: string;
  /** All allowed Workspace domains for login + validation. */
  hostedDomains: string[];
  source: {
    clientId: Source;
    clientSecret: Source;
    hostedDomain: Source;
  };
}

type GoogleOidcRow = {
  google_oidc_client_id: string | null;
  google_oidc_client_secret: string | null;
  google_oidc_hosted_domain: string | null;
};

function trimString(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function pickSetting(dbValue: string | null | undefined, envValue: string): { value: string; source: Source } {
  const db = trimString(dbValue);
  if (db) return { value: db, source: 'db' };
  return { value: trimString(envValue), source: 'env' };
}

async function loadConnectorHostedDomains(): Promise<string[]> {
  try {
    const row = await queryOne<{ config_json: unknown }>(
      `SELECT config_json FROM connectors
        WHERE slug = 'google-workspace' AND status IN ('CONNECTED', 'ACTIVE', 'CONFIGURED')
        LIMIT 1`,
      [],
    );
    if (!row?.config_json) return [];

    const cfg = (
      typeof row.config_json === 'string'
        ? JSON.parse(row.config_json) as Record<string, unknown>
        : row.config_json
    ) as Record<string, unknown>;

    return parseGoogleHostedDomains(cfg['customerDomains'] ?? cfg['customerDomain'] ?? '');
  } catch {
    return [];
  }
}

export async function getGoogleOidcConfig(): Promise<GoogleOidcConfig> {
  const envClientId = trimString(config.google.clientId);
  const envClientSecret = trimString(config.google.clientSecret);
  const envHostedDomain = trimString(config.google.hostedDomain);

  let row: GoogleOidcRow | null = null;
  try {
    row = await queryOne<GoogleOidcRow>(
      `SELECT google_oidc_client_id, google_oidc_client_secret, google_oidc_hosted_domain
         FROM general_settings
        WHERE id = 1`,
      [],
    );
  } catch {
    // Fallback to env defaults when migration is not yet applied.
  }

  const clientId = pickSetting(row?.google_oidc_client_id, envClientId);
  const clientSecret = pickSetting(row?.google_oidc_client_secret, envClientSecret);
  const hostedDomainSetting = pickSetting(row?.google_oidc_hosted_domain, envHostedDomain);
  const connectorDomains = await loadConnectorHostedDomains();
  const oidcDomains = parseGoogleHostedDomains(hostedDomainSetting.value);
  const hostedDomains = mergeGoogleHostedDomains(oidcDomains, connectorDomains);
  const hostedDomainSource: Source = oidcDomains.length
    ? hostedDomainSetting.source
    : (connectorDomains.length ? 'connector' : hostedDomainSetting.source);

  return {
    clientId: clientId.value,
    clientSecret: clientSecret.value,
    hostedDomain: primaryGoogleHostedDomain(hostedDomains),
    hostedDomains,
    source: {
      clientId: clientId.source,
      clientSecret: clientSecret.source,
      hostedDomain: hostedDomainSource,
    },
  };
}

export function isGoogleOidcConfigured(
  cfg: Pick<GoogleOidcConfig, 'clientId' | 'clientSecret' | 'hostedDomains'>,
): boolean {
  return Boolean(
    cfg.clientId &&
      cfg.clientSecret &&
      cfg.hostedDomains.length > 0 &&
      !cfg.clientId.startsWith('REPLACE_ME') &&
      !cfg.clientSecret.startsWith('REPLACE_ME'),
  );
}
