/**
 * OIDC redirect URI normalization — Grafana/PMM often register …/login while
 * the SP sends …/login/generic_oauth (sometimes under /graph).
 */
import { inferGrafanaStyleLaunchUrl } from './portal-launch.js';

export function normalizeRedirectUri(uri: string): string {
  try {
    const u = new URL(uri.trim());
    u.hash = '';
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.replace(/\/+$/, '');
    }
    return u.toString();
  } catch {
    return uri.trim();
  }
}

/** True when `requested` matches `registered` (exact or Grafana-style inference). */
export function redirectUrisMatch(registered: string, requested: string): boolean {
  const r = normalizeRedirectUri(registered);
  const q = normalizeRedirectUri(requested);
  if (r === q) return true;

  const inferredFromReg = inferGrafanaStyleLaunchUrl(r);
  if (inferredFromReg && normalizeRedirectUri(inferredFromReg) === q) return true;

  const inferredFromReq = inferGrafanaStyleLaunchUrl(q);
  if (inferredFromReq && normalizeRedirectUri(inferredFromReq) === r) return true;

  return false;
}

/** Expand redirect URIs with Grafana/PMM generic_oauth variants for registration. */
export function expandOidcRedirectUris(uris: string[]): string[] {
  const out = new Set<string>();
  for (const raw of uris) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    out.add(trimmed);
    out.add(normalizeRedirectUri(trimmed));
    const grafana = inferGrafanaStyleLaunchUrl(trimmed);
    if (grafana) {
      out.add(grafana);
      out.add(normalizeRedirectUri(grafana));
    }
  }
  return [...out];
}

/** Registered form to store on the auth code (stable for token-step comparison). */
export function canonicalRedirectUri(registeredUris: string[], requested: string): string {
  for (const r of registeredUris) {
    if (redirectUrisMatch(r, requested)) return normalizeRedirectUri(r);
  }
  return normalizeRedirectUri(requested);
}
