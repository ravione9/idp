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

/** Never pair DB client_id with a different env client_secret — causes Google invalid_client. */
function resolveGoogleOAuthCredentials(
  row: GoogleOidcRow | null,
  envClientId: string,
  envClientSecret: string,
): { clientId: string; clientSecret: string; source: { clientId: Source; clientSecret: Source } } {
  const dbId = trimString(row?.google_oidc_client_id);
  const dbSecret = trimString(row?.google_oidc_client_secret);

  if (dbId && dbSecret) {
    return {
      clientId: dbId,
      clientSecret: dbSecret,
      source: { clientId: 'db', clientSecret: 'db' },
    };
  }

  if (!dbId && !dbSecret) {
    return {
      clientId: envClientId,
      clientSecret: envClientSecret,
      source: { clientId: 'env', clientSecret: 'env' },
    };
  }

  if (dbId && !dbSecret && envClientId === dbId && envClientSecret) {
    return {
      clientId: dbId,
      clientSecret: envClientSecret,
      source: { clientId: 'db', clientSecret: 'env' },
    };
  }

  return {
    clientId: dbId || envClientId,
    clientSecret: dbSecret || (dbId && envClientId === dbId ? envClientSecret : ''),
    source: {
      clientId: dbId ? 'db' : 'env',
      clientSecret: dbSecret ? 'db' : (dbId && envClientId === dbId ? 'env' : dbId ? 'db' : 'env'),
    },
  };
}

export function googleOidcCredentialPairMismatch(
  cfg: Pick<GoogleOidcConfig, 'clientId' | 'clientSecret' | 'source'>,
): boolean {
  if (!cfg.clientId) return false;
  if (!cfg.clientSecret) return true;
  if (cfg.source.clientId === 'db' && cfg.source.clientSecret === 'env') return false;
  return cfg.source.clientId !== cfg.source.clientSecret;
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

  const creds = resolveGoogleOAuthCredentials(row, envClientId, envClientSecret);
  const hostedDomainSetting = pickSetting(row?.google_oidc_hosted_domain, envHostedDomain);
  const connectorDomains = await loadConnectorHostedDomains();
  const oidcDomains = parseGoogleHostedDomains(hostedDomainSetting.value);
  const hostedDomains = mergeGoogleHostedDomains(oidcDomains, connectorDomains);
  const hostedDomainSource: Source = oidcDomains.length
    ? hostedDomainSetting.source
    : (connectorDomains.length ? 'connector' : hostedDomainSetting.source);

  return {
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    hostedDomain: primaryGoogleHostedDomain(hostedDomains),
    hostedDomains,
    source: {
      clientId: creds.source.clientId,
      clientSecret: creds.source.clientSecret,
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
