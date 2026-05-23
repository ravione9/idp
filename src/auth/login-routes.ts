/**
 * LILG — OIDC login initiation (Google).
 *
 * Zoho was removed as a portal sign-in method — Zoho Mail is now consumed as
 * a SAML application served by this IdP rather than a federated identity
 * provider. See ARCHITECTURE.md.
 */

import { Request, Response } from 'express';
import { config } from '../config.js';

/** Public origin for OAuth redirects — prefers PUBLIC_BASE_URL / SAML_IDP_BASE_URL (idp.lenskart.com). */
function baseUrl(req: Request): string {
  if (config.app.publicBaseUrl) {
    return config.app.publicBaseUrl;
  }
  const proto = req.get('x-forwarded-proto') ?? req.protocol;
  const host  = req.get('x-forwarded-host') ?? req.get('host') ?? 'localhost:8080';
  return `${proto}://${host}`;
}

function safeReturnTo(raw: string | undefined): string {
  if (!raw || !raw.startsWith('/')) return '/';
  if (raw.startsWith('//')) return '/';
  return raw;
}

export function googleLoginHandler(req: Request, res: Response): void {
  const returnTo = safeReturnTo(req.query['returnTo'] as string | undefined);
  const redirectUri = `${baseUrl(req)}/auth/google/callback`;
  const state = Buffer.from(JSON.stringify({ returnTo }), 'utf8').toString('base64url');

  const params = new URLSearchParams({
    client_id:     config.google.clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         'openid email profile',
    access_type:   'online',
    hd:            config.google.hostedDomain,
    state,
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
}

export function parseOAuthState(state: string | undefined): { returnTo: string } {
  if (!state) return { returnTo: '/' };
  try {
    const parsed = JSON.parse(Buffer.from(state, 'base64url').toString('utf8')) as { returnTo?: string };
    return { returnTo: safeReturnTo(parsed.returnTo) };
  } catch {
    return { returnTo: '/' };
  }
}
