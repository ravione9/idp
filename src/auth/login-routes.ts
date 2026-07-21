/**
 * LILG — OIDC login initiation (Google).
 *
 * Zoho was removed as a portal sign-in method — Zoho Mail is now consumed as
 * a SAML application served by this IdP rather than a federated identity
 * provider. See ARCHITECTURE.md.
 *
 * Note: Directory sync uses a Google *service account*; portal sign-in uses a
 * separate OAuth *Web client* (Client ID + Secret). Sync working does not prove
 * portal OAuth is configured correctly.
 */

import { Request, Response } from 'express';
import logger from '../utils/logger.js';
import { getGoogleOidcConfig, isGoogleOidcConfigured } from './google-oidc-config.js';
import { getGoogleOAuthRedirectUri } from './google-oauth-redirect.js';
import { redirectLoginAuthError } from './login-redirect.js';

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
    const redirectUri = getGoogleOAuthRedirectUri(req);
    // Persist redirectUri in state so token exchange uses the identical string
    const state = Buffer.from(JSON.stringify({ returnTo, redirectUri }), 'utf8').toString('base64url');

    const params = new URLSearchParams({
      client_id:     oidc.clientId,
      redirect_uri:  redirectUri,
      response_type: 'code',
      scope:         'openid email profile',
      access_type:   'online',
      prompt:        'select_account',
      state,
    });

    // Google hd= accepts only one domain; omit when multiple Workspace domains are allowed.
    if (oidc.hostedDomains.length === 1) {
      params.set('hd', oidc.hostedDomains[0]!);
    }

    logger.info(
      { redirectUri, clientIdSuffix: oidc.clientId.slice(-12), hostedDomains: oidc.hostedDomains },
      'Starting Google OIDC login',
    );
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  } catch (err) {
    logger.error({ err }, 'Failed to start Google OIDC login');
    redirectLoginAuthError(res, 'google_setup_failed', safeReturnTo(req.query['returnTo'] as string | undefined));
  }
}

export function parseOAuthState(state: string | undefined): { returnTo: string; redirectUri?: string } {
  if (!state) return { returnTo: '/' };
  try {
    const parsed = JSON.parse(Buffer.from(state, 'base64url').toString('utf8')) as {
      returnTo?: string;
      redirectUri?: string;
    };
    const redirectUri = typeof parsed.redirectUri === 'string' && parsed.redirectUri.startsWith('https://')
      ? parsed.redirectUri
      : undefined;
    return {
      returnTo: safeReturnTo(parsed.returnTo),
      ...(redirectUri ? { redirectUri } : {}),
    };
  } catch {
    return { returnTo: '/' };
  }
}
