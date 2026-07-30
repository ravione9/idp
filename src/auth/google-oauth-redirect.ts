/**
 * Canonical Google OAuth redirect URI for portal sign-in.
 * Authorize and token exchange must use the exact same string.
 */
import type { Request } from 'express';
import { config } from '../config.js';
import { getPublicOrigin } from '../utils/request-context.js';

export function getGoogleOAuthRedirectUri(req?: Request): string {
  const base = (config.app.publicBaseUrl || (req ? getPublicOrigin(req) : '')).replace(/\/$/, '');
  if (!base) {
    throw new Error('PUBLIC_BASE_URL (or SAML_IDP_BASE_URL) must be set for Google portal sign-in');
  }
  return `${base}/auth/google/callback`;
}
