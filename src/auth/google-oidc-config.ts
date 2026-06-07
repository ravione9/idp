import { config } from '../config.js';
import { queryOne } from '../db/connection.js';

type Source = 'env' | 'db';

export interface GoogleOidcConfig {
  clientId: string;
  clientSecret: string;
  hostedDomain: string;
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
  const hostedDomain = pickSetting(row?.google_oidc_hosted_domain, envHostedDomain);

  return {
    clientId: clientId.value,
    clientSecret: clientSecret.value,
    hostedDomain: hostedDomain.value,
    source: {
      clientId: clientId.source,
      clientSecret: clientSecret.source,
      hostedDomain: hostedDomain.source,
    },
  };
}

export function isGoogleOidcConfigured(cfg: Pick<GoogleOidcConfig, 'clientId' | 'clientSecret' | 'hostedDomain'>): boolean {
  return Boolean(
    cfg.clientId &&
      cfg.clientSecret &&
      cfg.hostedDomain &&
      !cfg.clientId.startsWith('REPLACE_ME') &&
      !cfg.clientSecret.startsWith('REPLACE_ME'),
  );
}
