/**
 * OIDC portal tile launch — must start the SP's OAuth flow (PKCE + state),
 * not IdP-initiated /oauth/authorize (breaks Grafana and most OIDC RPs).
 */
import { queryOne } from '../db/connection.js';
import { upsertAppProtocolConfig } from '../services/app-protocol-config.js';

function parseConfig(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return typeof parsed === 'object' && parsed && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** Grafana generic_oauth uses the same URL for callback and SSO button launch. */
function inferLaunchFromRedirectUri(redirectUri: string): string | null {
  const trimmed = redirectUri.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.pathname.includes('generic_oauth') || url.pathname.endsWith('/login/oauth')) {
      return trimmed;
    }
    return trimmed;
  } catch {
    return null;
  }
}

export async function resolveOidcSpLaunchUrl(
  catalogSlug: string,
  redirectUris: string[],
): Promise<string | null> {
  const app = await queryOne<{ id: string }>(
    `SELECT id FROM applications WHERE slug = ? AND active = 1 LIMIT 1`,
    [catalogSlug],
  );
  if (app) {
    const row = await queryOne<{ config: unknown }>(
      `SELECT config FROM app_protocol_configs
        WHERE app_id = ? AND protocol = 'OIDC' AND active = 1 LIMIT 1`,
      [app.id],
    );
    const cfg = parseConfig(row?.config);
    const configured = cfg['portalLaunchUrl'] ?? cfg['portal_launch_url'];
    if (typeof configured === 'string' && configured.trim()) {
      return configured.trim();
    }
  }

  for (const uri of redirectUris) {
    const inferred = inferLaunchFromRedirectUri(uri);
    if (inferred) return inferred;
  }
  return null;
}

export async function ensureOidcProtocolLaunchConfig(params: {
  appId: string;
  clientId: string;
  redirectUris: string[];
  portalLaunchUrl?: string | null;
}): Promise<string | null> {
  const launch =
    (params.portalLaunchUrl?.trim())
    || params.redirectUris.map(inferLaunchFromRedirectUri).find(Boolean)
    || null;
  if (!launch) return null;

  const existing = await queryOne<{ config: unknown }>(
    `SELECT config FROM app_protocol_configs
      WHERE app_id = ? AND protocol = 'OIDC' LIMIT 1`,
    [params.appId],
  );
  const merged = {
    ...parseConfig(existing?.config),
    clientId: params.clientId,
    redirectUris: params.redirectUris,
    portalLaunchUrl: launch,
  };
  await upsertAppProtocolConfig(params.appId, 'OIDC', merged);
  return launch;
}
