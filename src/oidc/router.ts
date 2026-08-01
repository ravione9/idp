/**
 * OIDC / OAuth 2.0 Authorization Server (OP)
 *
 *   GET  /.well-known/openid-configuration
 *   GET  /.well-known/jwks.json
 *   GET  /oauth/authorize
 *   GET  /oauth/resume/:pendingId
 *   POST /oauth/token
 *   GET|POST /oauth/userinfo
 */
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { importJWK, jwtVerify } from 'jose';
import { z } from 'zod';
import { resolveSession } from '../auth/middleware.js';
import { redis } from '../auth/session-store.js';
import { getPublicOrigin } from '../utils/request-context.js';
import { asyncHandler } from '../utils/async-handler.js';
import logger from '../utils/logger.js';
import {
  enforceCriticalAppMfaOrRedirect,
  getAppMfaByOidcClientId,
  redirectAppMfaStepUp,
  sessionSatisfiesAppMfa,
} from '../services/app-mfa-stepup.js';
import {
  getOidcClientByClientId,
  intersectScopes,
  isRedirectUriAllowed,
  verifyClientSecret,
  type OidcClient,
} from './clients.js';
import { loadUserClaims } from './claims.js';
import { getOidcJwks } from './keys.js';
import {
  consumeAuthorizationCode,
  consumeRefreshToken,
  issueAuthorizationCode,
  issueRefreshToken,
  mintAccessToken,
  mintIdToken,
  verifyPkce,
} from './tokens.js';

const PENDING_OAUTH_PREFIX = 'lilg:oauth-pending:';
const PENDING_OAUTH_TTL_S = 600;

const router = Router();

function issuerFrom(req: Request): string {
  return getPublicOrigin(req);
}

function parseBasicAuth(header: string | undefined): { id: string; secret: string } | null {
  if (!header?.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return { id: decoded.slice(0, idx), secret: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

function oauthErrorRedirect(
  res: Response,
  redirectUri: string,
  error: string,
  desc: string,
  state?: string,
): void {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  url.searchParams.set('error_description', desc);
  if (state) url.searchParams.set('state', state);
  res.redirect(url.toString());
}

function tokenError(res: Response, status: number, error: string, description: string): void {
  res.status(status).json({ error, error_description: description });
}

// ---------------------------------------------------------------------------
// Discovery + JWKS
// ---------------------------------------------------------------------------
router.get('/.well-known/openid-configuration', (req: Request, res: Response) => {
  const iss = issuerFrom(req);
  res.json({
    issuer: iss,
    authorization_endpoint: `${iss}/oauth/authorize`,
    token_endpoint: `${iss}/oauth/token`,
    userinfo_endpoint: `${iss}/oauth/userinfo`,
    jwks_uri: `${iss}/.well-known/jwks.json`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    // IDP-03 — advertise confidential-client methods only. Public clients still
    // authenticate with client_id + mandatory S256 PKCE (token_endpoint_auth_method=none).
    token_endpoint_auth_methods_supported: [
      'client_secret_basic',
      'client_secret_post',
    ],
    scopes_supported: ['openid', 'email', 'profile', 'offline_access'],
    claims_supported: [
      'sub', 'iss', 'aud', 'exp', 'iat', 'auth_time', 'nonce',
      'email', 'email_verified', 'name', 'preferred_username',
      'given_name', 'family_name', 'emp_id', 'role',
    ],
    // IDP-02 — RFC 9700 deprecates plain PKCE; S256 only.
    code_challenge_methods_supported: ['S256'],
    request_parameter_supported: false,
    request_uri_parameter_supported: false,
  });
});

router.get('/.well-known/jwks.json', (_req: Request, res: Response) => {
  res.json(getOidcJwks());
});

// ---------------------------------------------------------------------------
// Authorize
// ---------------------------------------------------------------------------
const authorizeQuerySchema = z.object({
  client_id: z.string().min(1),
  redirect_uri: z.string().url(),
  response_type: z.string().default('code'),
  scope: z.string().optional(),
  state: z.string().optional(),
  nonce: z.string().optional(),
  code_challenge: z.string().optional(),
  code_challenge_method: z.enum(['S256']).optional(),
});

async function completeAuthorize(
  res: Response,
  params: z.infer<typeof authorizeQuerySchema>,
  client: OidcClient,
  empId: string,
): Promise<void> {
  const requestedScopes = (params.scope ?? 'openid').split(/\s+/).filter(Boolean);
  const scopes = intersectScopes(requestedScopes, client.scopes);
  if (!scopes.includes('openid')) {
    oauthErrorRedirect(res, params.redirect_uri, 'invalid_scope', 'openid scope is required', params.state);
    return;
  }

  const needsPkce = client.requirePkce || client.clientType === 'PUBLIC';
  if (needsPkce && !params.code_challenge) {
    oauthErrorRedirect(res, params.redirect_uri, 'invalid_request', 'PKCE code_challenge is required', params.state);
    return;
  }
  if (params.code_challenge) {
    const method = params.code_challenge_method ?? 'S256';
    if (method !== 'S256') {
      oauthErrorRedirect(res, params.redirect_uri, 'invalid_request', 'Only S256 PKCE is supported', params.state);
      return;
    }
  }

  const claims = await loadUserClaims(empId, scopes);
  if (!claims) {
    oauthErrorRedirect(res, params.redirect_uri, 'access_denied', 'User is not eligible for SSO', params.state);
    return;
  }

  const codeParams: Parameters<typeof issueAuthorizationCode>[0] = {
    clientId: client.clientId,
    empId,
    scope: scopes.join(' '),
    redirectUri: params.redirect_uri,
  };
  if (params.nonce) codeParams.nonce = params.nonce;
  if (params.code_challenge) {
    codeParams.pkceChallenge = params.code_challenge;
    codeParams.pkceMethod = 'S256';
  }
  const code = await issueAuthorizationCode(codeParams);

  const url = new URL(params.redirect_uri);
  url.searchParams.set('code', code);
  if (params.state) url.searchParams.set('state', params.state);

  logger.info({ empId, clientId: client.clientId }, 'OIDC authorization code issued');
  res.redirect(url.toString());
}

router.get('/oauth/authorize', asyncHandler(async (req: Request, res: Response) => {
  const parsed = authorizeQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', error_description: 'Missing or invalid authorize parameters' });
    return;
  }
  const params = parsed.data;

  if (params.response_type !== 'code') {
    res.status(400).json({ error: 'unsupported_response_type', error_description: 'Only response_type=code is supported' });
    return;
  }

  const client = await getOidcClientByClientId(params.client_id);
  if (!client) {
    res.status(400).json({ error: 'invalid_client', error_description: 'Unknown client_id' });
    return;
  }
  if (!isRedirectUriAllowed(client, params.redirect_uri)) {
    res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri is not registered for this client' });
    return;
  }
  if (client.responseTypes.length && !client.responseTypes.includes('code')) {
    oauthErrorRedirect(res, params.redirect_uri, 'unauthorized_client', 'Client is not allowed response_type=code', params.state);
    return;
  }
  if (client.grantTypes.length && !client.grantTypes.includes('authorization_code')) {
    oauthErrorRedirect(res, params.redirect_uri, 'unauthorized_client', 'authorization_code grant not allowed', params.state);
    return;
  }

  const user = await resolveSession(req, res);
  if (!user) {
    const pendingId = uuidv4();
    await redis.set(
      `${PENDING_OAUTH_PREFIX}${pendingId}`,
      JSON.stringify(params),
      'EX',
      PENDING_OAUTH_TTL_S,
    );
    const returnTo = encodeURIComponent(`/oauth/resume/${pendingId}`);
    res.redirect(`/login?returnTo=${returnTo}`);
    return;
  }

  {
    const appMfa = await getAppMfaByOidcClientId(params.client_id);
    if (!(await sessionSatisfiesAppMfa(user.sessionId, appMfa))) {
      const pendingId = uuidv4();
      await redis.set(
        `${PENDING_OAUTH_PREFIX}${pendingId}`,
        JSON.stringify(params),
        'EX',
        PENDING_OAUTH_TTL_S,
      );
      redirectAppMfaStepUp(res, `/oauth/resume/${pendingId}`, appMfa?.name || client.name);
      return;
    }
  }

  await completeAuthorize(res, params, client, user.empId);
}));

router.get('/oauth/resume/:pendingId', asyncHandler(async (req: Request, res: Response) => {
  const user = await resolveSession(req, res);
  if (!user) {
    res.redirect(`/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
    return;
  }

  const pendingKey = `${PENDING_OAUTH_PREFIX}${req.params['pendingId']}`;
  const raw = await redis.get(pendingKey);
  if (!raw) {
    res.status(410).send('OAuth authorization session expired. Restart sign-in from the application.');
    return;
  }

  const params = authorizeQuerySchema.parse(JSON.parse(raw));
  const client = await getOidcClientByClientId(params.client_id);
  if (!client || !isRedirectUriAllowed(client, params.redirect_uri)) {
    await redis.del(pendingKey);
    res.status(400).send('Invalid OAuth client or redirect URI');
    return;
  }

  {
    const appMfa = await getAppMfaByOidcClientId(params.client_id);
    const ok = await enforceCriticalAppMfaOrRedirect(req, res, {
      sessionId: user.sessionId,
      returnPath: `/oauth/resume/${req.params['pendingId']}`,
      app: appMfa,
    });
    if (!ok) return;
  }

  await redis.del(pendingKey);
  await completeAuthorize(res, params, client, user.empId);
}));

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------
async function authenticateTokenClient(
  req: Request,
  body: Record<string, unknown>,
): Promise<{ client: OidcClient } | { error: string; description: string }> {
  const basic = parseBasicAuth(req.get('authorization') ?? undefined);
  const clientId = basic?.id ?? (typeof body['client_id'] === 'string' ? body['client_id'] : undefined);
  const clientSecret = basic?.secret
    ?? (typeof body['client_secret'] === 'string' ? body['client_secret'] : undefined);

  if (!clientId) {
    return { error: 'invalid_client', description: 'client_id is required' };
  }

  const client = await getOidcClientByClientId(clientId);
  if (!client) {
    return { error: 'invalid_client', description: 'Unknown client' };
  }

  const method = client.tokenEndpointAuthMethod;
  if (method === 'client_secret_basic' || method === 'client_secret_post') {
    const ok = await verifyClientSecret(client, clientSecret);
    if (!ok) {
      return { error: 'invalid_client', description: 'Invalid client credentials' };
    }
  } else if (method === 'none') {
    // Public clients only — must use PKCE S256 (enforced on authorization_code grant).
    if (client.clientType !== 'PUBLIC') {
      return { error: 'invalid_client', description: 'Client authentication required' };
    }
    if (clientSecret) {
      return { error: 'invalid_client', description: 'Public clients must not send client_secret' };
    }
  } else {
    // private_key_jwt not yet supported — fall back to secret if provided
    const ok = await verifyClientSecret(client, clientSecret);
    if (!ok && client.clientType === 'CONFIDENTIAL') {
      return { error: 'invalid_client', description: 'Client authentication failed' };
    }
  }

  return { client };
}

router.post('/oauth/token', asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const grantType = typeof body['grant_type'] === 'string' ? body['grant_type'] : '';

  const auth = await authenticateTokenClient(req, body);
  if ('error' in auth) {
    res.setHeader('WWW-Authenticate', 'Basic');
    tokenError(res, 401, auth.error, auth.description);
    return;
  }
  const { client } = auth;
  const issuer = issuerFrom(req);

  if (grantType === 'authorization_code') {
    if (!client.grantTypes.includes('authorization_code') && client.grantTypes.length) {
      tokenError(res, 400, 'unauthorized_client', 'authorization_code grant not allowed');
      return;
    }

    const code = typeof body['code'] === 'string' ? body['code'] : '';
    const redirectUri = typeof body['redirect_uri'] === 'string' ? body['redirect_uri'] : '';
    const codeVerifier = typeof body['code_verifier'] === 'string' ? body['code_verifier'] : undefined;

    if (!code || !redirectUri) {
      tokenError(res, 400, 'invalid_request', 'code and redirect_uri are required');
      return;
    }

    const stored = await consumeAuthorizationCode(code);
    if (!stored || stored.clientId !== client.clientId) {
      tokenError(res, 400, 'invalid_grant', 'Authorization code is invalid or expired');
      return;
    }
    if (stored.redirectUri !== redirectUri) {
      tokenError(res, 400, 'invalid_grant', 'redirect_uri mismatch');
      return;
    }

    const needsPkce = client.requirePkce || client.clientType === 'PUBLIC' || !!stored.pkceChallenge;
    if (needsPkce) {
      if (!stored.pkceChallenge || !verifyPkce(stored.pkceMethod, stored.pkceChallenge, codeVerifier)) {
        tokenError(res, 400, 'invalid_grant', 'PKCE verification failed');
        return;
      }
    }

    const scope = stored.scope ?? 'openid';
    const scopes = scope.split(/\s+/).filter(Boolean);
    const claims = await loadUserClaims(stored.empId, scopes);
    if (!claims) {
      tokenError(res, 400, 'invalid_grant', 'User is no longer eligible');
      return;
    }

    const { accessToken, expiresIn } = await mintAccessToken({
      issuer, clientId: client.clientId, claims, scope,
    });

    const response: Record<string, unknown> = {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      scope,
    };

    if (scopes.includes('openid')) {
      response['id_token'] = await mintIdToken({
        issuer,
        clientId: client.clientId,
        claims,
        nonce: stored.nonce,
        authTime: Math.floor(Date.now() / 1000),
      });
    }

    if (scopes.includes('offline_access') || client.grantTypes.includes('refresh_token')) {
      response['refresh_token'] = await issueRefreshToken({
        clientId: client.clientId,
        empId: stored.empId,
        scope,
      });
    }

    logger.info({ empId: stored.empId, clientId: client.clientId }, 'OIDC tokens issued');
    res.json(response);
    return;
  }

  if (grantType === 'refresh_token') {
    if (client.grantTypes.length && !client.grantTypes.includes('refresh_token')) {
      tokenError(res, 400, 'unauthorized_client', 'refresh_token grant not allowed');
      return;
    }

    const refreshToken = typeof body['refresh_token'] === 'string' ? body['refresh_token'] : '';
    if (!refreshToken) {
      tokenError(res, 400, 'invalid_request', 'refresh_token is required');
      return;
    }

    const stored = await consumeRefreshToken(refreshToken);
    if (!stored || stored.clientId !== client.clientId) {
      tokenError(res, 400, 'invalid_grant', 'Refresh token is invalid or expired');
      return;
    }

    const scope = stored.scope ?? 'openid';
    const scopes = scope.split(/\s+/).filter(Boolean);
    const claims = await loadUserClaims(stored.empId, scopes);
    if (!claims) {
      tokenError(res, 400, 'invalid_grant', 'User is no longer eligible');
      return;
    }

    const { accessToken, expiresIn } = await mintAccessToken({
      issuer, clientId: client.clientId, claims, scope,
    });

    const newRefresh = await issueRefreshToken({
      clientId: client.clientId,
      empId: stored.empId,
      scope,
    });

    const response: Record<string, unknown> = {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: newRefresh,
      scope,
    };

    if (scopes.includes('openid')) {
      response['id_token'] = await mintIdToken({
        issuer,
        clientId: client.clientId,
        claims,
      });
    }

    res.json(response);
    return;
  }

  tokenError(res, 400, 'unsupported_grant_type', 'Only authorization_code and refresh_token are supported');
}));

// ---------------------------------------------------------------------------
// UserInfo
// ---------------------------------------------------------------------------
async function handleUserInfo(req: Request, res: Response): Promise<void> {
  const header = req.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]
    ?? (typeof req.body?.['access_token'] === 'string' ? req.body['access_token'] as string : undefined);

  if (!token) {
    res.status(401).json({ error: 'invalid_token', error_description: 'Bearer access token required' });
    return;
  }

  try {
    const jwk = getOidcJwks().keys[0];
    if (!jwk) {
      res.status(503).json({ error: 'server_error', error_description: 'Signing keys unavailable' });
      return;
    }
    const key = await importJWK(jwk, 'RS256');
    const { payload } = await jwtVerify(token, key, {
      issuer: issuerFrom(req),
    });

    if (payload['token_use'] && payload['token_use'] !== 'access') {
      res.status(401).json({ error: 'invalid_token', error_description: 'Not an access token' });
      return;
    }

    const empId = String(payload.sub ?? '');
    const scope = typeof payload['scope'] === 'string' ? payload['scope'] : 'openid email profile';
    const claims = await loadUserClaims(empId, scope.split(/\s+/));
    if (!claims) {
      res.status(401).json({ error: 'invalid_token', error_description: 'Subject not found' });
      return;
    }

    res.json(claims);
  } catch (err) {
    logger.warn({ err }, 'OIDC userinfo token verification failed');
    res.status(401).json({ error: 'invalid_token', error_description: 'Access token is invalid or expired' });
  }
}

router.get('/oauth/userinfo', asyncHandler(handleUserInfo));
router.post('/oauth/userinfo', asyncHandler(handleUserInfo));

export default router;
