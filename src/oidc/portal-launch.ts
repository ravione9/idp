/**
 * OIDC portal tile launch — must start the SP's OAuth flow (PKCE + state),
 * not IdP-initiated /oauth/authorize (breaks Grafana, PMM, and most OIDC RPs).
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

/** True when URL is an SP-side OAuth/SAML entrypoint, not a bare login page or API callback. */
export function isLikelySpOAuthLaunchUrl(urlStr: string): boolean {
  try {
    const path = new URL(urlStr).pathname.toLowerCase();
    if (path.includes('generic_oauth')) return true;
    if (/\/oauth2?\/(authorize|login)/.test(path)) return true;
    if (path.includes('/sso') && !path.includes('callback')) return true;
    if (path.endsWith('/oauth') && !path.includes('callback')) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Grafana / PMM (Grafana-based): SSO button hits …/login/generic_oauth (may be under /graph).
 * The OAuth redirect_uri registered in the IdP is usually the same path — never the bare /login page.
 */
export function inferGrafanaStyleLaunchUrl(redirectUri: string): string | null {
  const trimmed = redirectUri.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path.toLowerCase().includes('generic_oauth')) {
      return trimmed;
    }

    // …/login or …/graph/login → …/login/generic_oauth or …/graph/login/generic_oauth
    if (/\/login$/i.test(path) && !path.toLowerCase().includes('generic_oauth')) {
      return `${url.origin}${path}/generic_oauth`;
    }

    // Subpath root (e.g. PMM served under /graph)
    if (path === '/graph' || path.endsWith('/graph')) {
      return `${url.origin}${path}/login/generic_oauth`;
    }

    return null;
  } catch {
    return null;
  }
}

/** Pick the best SP-initiated launch URL from registered redirect URIs. */
export function pickOidcSpLaunchUrl(redirectUris: string[]): string | null {
  const cleaned = redirectUris.map((u) => u.trim()).filter(Boolean);
  if (!cleaned.length) return null;

  for (const uri of cleaned) {
    if (isLikelySpOAuthLaunchUrl(uri)) return uri;
  }

  for (const uri of cleaned) {
    const grafana = inferGrafanaStyleLaunchUrl(uri);
    if (grafana) return grafana;
  }

  // Last resort: only if a single redirect looks like an OAuth callback path we can rewrite
  for (const uri of cleaned) {
    try {
      const url = new URL(uri);
      const path = url.pathname.toLowerCase();
      if (path.includes('callback') || path.includes('redirect')) continue;
    } catch {
      continue;
    }
  }

  return null;
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
      const url = configured.trim();
      if (isLikelySpOAuthLaunchUrl(url)) return url;
      const repaired = inferGrafanaStyleLaunchUrl(url) || pickOidcSpLaunchUrl(redirectUris);
      if (repaired) return repaired;
    }
  }

  return pickOidcSpLaunchUrl(redirectUris);
}

export async function ensureOidcProtocolLaunchConfig(params: {
  appId: string;
  clientId: string;
  redirectUris: string[];
  portalLaunchUrl?: string | null;
}): Promise<string | null> {
  const existing = await queryOne<{ config: unknown }>(
    `SELECT config FROM app_protocol_configs
      WHERE app_id = ? AND protocol = 'OIDC' LIMIT 1`,
    [params.appId],
  );
  const cfg = parseConfig(existing?.config);
  const storedRaw = cfg['portalLaunchUrl'] ?? cfg['portal_launch_url'];
  const stored = typeof storedRaw === 'string' ? storedRaw.trim() : '';
  const explicit = params.portalLaunchUrl?.trim() || null;

  let launch: string | null = null;
  if (explicit) {
    launch = isLikelySpOAuthLaunchUrl(explicit) ? explicit : inferGrafanaStyleLaunchUrl(explicit);
  }
  if (!launch && stored && isLikelySpOAuthLaunchUrl(stored)) {
    launch = stored;
  }
  if (!launch) {
    launch = pickOidcSpLaunchUrl(params.redirectUris);
  }
  if (!launch && stored) {
    launch = inferGrafanaStyleLaunchUrl(stored);
  }
  if (!launch) return null;

  const merged = {
    ...cfg,
    clientId: params.clientId,
    redirectUris: params.redirectUris,
    portalLaunchUrl: launch,
  };
  await upsertAppProtocolConfig(params.appId, 'OIDC', merged);
  return launch;
}
