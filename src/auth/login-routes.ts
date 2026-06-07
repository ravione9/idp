/**
 * LILG — OIDC login initiation (Google).
 *
 * Zoho was removed as a portal sign-in method — Zoho Mail is now consumed as
 * a SAML application served by this IdP rather than a federated identity
 * provider. See ARCHITECTURE.md.
 */

import { Request, Response } from 'express';
import { getPublicOrigin } from '../utils/request-context.js';
import logger from '../utils/logger.js';
import { getGoogleOidcConfig, isGoogleOidcConfigured } from './google-oidc-config.js';
import { redirectLoginAuthError } from './login-redirect.js';

function baseUrl(req: Request): string {
  return getPublicOrigin(req);
}

function safeReturnTo(raw: string | undefined): string {
  if (!raw || !raw.startsWith('/')) return '/';
  if (raw.startsWith('//')) return '/';
  return raw;
}

export async function googleLoginHandler(req: Request, res: Response): Promise<void> {
  try {
    const oidc = await getGoogleOidcConfig();
    if (!isGoogleOidcConfigured(oidc)) {
      redirectLoginAuthError(res, 'google_not_configured', safeReturnTo(req.query['returnTo'] as string | undefined));
      return;
    }

    const returnTo = safeReturnTo(req.query['returnTo'] as string | undefined);
    const redirectUri = `${baseUrl(req)}/auth/google/callback`;
    const state = Buffer.from(JSON.stringify({ returnTo }), 'utf8').toString('base64url');

    const params = new URLSearchParams({
      client_id:     oidc.clientId,
      redirect_uri:  redirectUri,
      response_type: 'code',
      scope:         'openid email profile',
      access_type:   'online',
      state,
    });

    // Google hd= accepts only one domain; omit when multiple Workspace domains are allowed.
    if (oidc.hostedDomains.length === 1) {
      params.set('hd', oidc.hostedDomains[0]!);
    }

    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  } catch (err) {
    logger.error({ err }, 'Failed to start Google OIDC login');
    redirectLoginAuthError(res, 'google_setup_failed', safeReturnTo(req.query['returnTo'] as string | undefined));
  }
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
