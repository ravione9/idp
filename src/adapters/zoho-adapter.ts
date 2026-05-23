import axios, { AxiosInstance, AxiosError } from 'axios';
import { Redis } from 'ioredis';
import { BaseAdapter, AdapterResult, UserInfo, Binding } from './base-adapter.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface TokenEntry {
  token: string;
  expiresAt: number; // epoch ms
}

interface ScimUser {
  id: string;
  userName: string;
  displayName?: string;
  active: boolean;
  emails?: Array<{ value: string; primary?: boolean }>;
  [key: string]: unknown;
}

interface ScimGroup {
  id: string;
  displayName: string;
  members?: Array<{ value: string }>;
}

interface ScimListResponse<T> {
  totalResults: number;
  Resources: T[];
}

// ---------------------------------------------------------------------------
// ZohoAdapter
// ---------------------------------------------------------------------------
export class ZohoAdapter extends BaseAdapter {
  private readonly http: AxiosInstance;
  private readonly tokenUrl = 'https://accounts.zoho.in/oauth/v2/token';

  /** In-memory token cache keyed by scope string */
  private readonly tokenCache = new Map<string, TokenEntry>();

  constructor(
    redis: Redis,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly scimBaseUrl: string,
  ) {
    super(redis, 'ZOHO');

    this.http = axios.create({
      baseURL: scimBaseUrl,
      timeout: 15_000,
      headers: { 'Content-Type': 'application/json' },
    });

    // Attach authorization header on every request
    this.http.interceptors.request.use(async (cfg) => {
      const token = await this.getAccessToken();
      cfg.headers['Authorization'] = `Zoho-oauthtoken ${token}`;
      return cfg;
    });
  }

  // ---------------------------------------------------------------------------
  // OAuth2 client_credentials token management
  // ---------------------------------------------------------------------------
  private async getAccessToken(scope = 'AaaServer.profile.READ,ZohoPeople.employee.ALL'): Promise<string> {
    const cached = this.tokenCache.get(scope);
    if (cached && cached.expiresAt > Date.now() + 30_000) {
      return cached.token;
    }

    const params = new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     this.clientId,
      client_secret: this.clientSecret,
      scope,
    });

    const res = await axios.post<{ access_token: string; expires_in: number }>(
      this.tokenUrl,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10_000 },
    );

    const entry: TokenEntry = {
      token:     res.data.access_token,
      expiresAt: Date.now() + res.data.expires_in * 1000,
    };
    this.tokenCache.set(scope, entry);
    logger.debug({ scope }, 'Zoho access token refreshed');
    return entry.token;
  }

  // ---------------------------------------------------------------------------
  // SCIM 2.0 request helper with Retry-After support
  // ---------------------------------------------------------------------------
  private async scimRequest<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    retries = 3,
  ): Promise<T> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await this.http.request<T>({ method, url: path, data: body });
        return res.data;
      } catch (err) {
        const axiosErr = err as AxiosError;
        const status = axiosErr.response?.status;

        if (status === 429) {
          const retryAfter = parseInt(
            (axiosErr.response?.headers['retry-after'] as string | undefined) ?? '5',
            10,
          );
          logger.warn({ path, retryAfter, attempt }, 'Zoho rate limited, backing off');
          await sleep(retryAfter * 1000);
          continue;
        }

        if (status === 404) {
          throw new ZohoNotFoundError(`Not found: ${path}`);
        }

        if (attempt === retries) throw err;

        // Exponential back-off for transient errors
        const delay = Math.min(1000 * Math.pow(2, attempt), 30_000);
        logger.warn({ path, status, attempt, delay }, 'Zoho request failed, retrying');
        await sleep(delay);
      }
    }
    throw new Error(`SCIM request failed after ${retries} retries: ${path}`);
  }

  // ---------------------------------------------------------------------------
  // BaseAdapter implementation
  // ---------------------------------------------------------------------------
  async getUser(externalId: string): Promise<AdapterResult<UserInfo>> {
    return this.safe(async () => {
      const user = await this.scimRequest<ScimUser>('GET', `/Users/${externalId}`);
      const primaryEmail = user.emails?.find((e) => e.primary)?.value ?? user.userName;

      return {
        externalId:  user.id,
        email:       primaryEmail,
        displayName: user.displayName ?? user.userName,
        active:      user.active,
        userName:    user.userName,
        zohoId:      user.id,
      };
    });
  }

  async disable(externalId: string, _evidence?: Record<string, unknown>): Promise<AdapterResult<void>> {
    return this.safe(async () => {
      try {
        await this.scimRequest('PATCH', `/Users/${externalId}`, {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'Replace', path: 'active', value: false }],
        });
        logger.info({ externalId }, 'Zoho user disabled');
      } catch (err) {
        if (err instanceof ZohoNotFoundError) {
          logger.warn({ externalId }, 'Zoho disable: user not found, treating as already removed');
          return;
        }
        throw err;
      }
    });
  }

  async enable(externalId: string): Promise<AdapterResult<void>> {
    return this.safe(async () => {
      try {
        await this.scimRequest('PATCH', `/Users/${externalId}`, {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'Replace', path: 'active', value: true }],
        });
        logger.info({ externalId }, 'Zoho user enabled');
      } catch (err) {
        if (err instanceof ZohoNotFoundError) {
          logger.warn({ externalId }, 'Zoho enable: user not found');
          return;
        }
        throw err;
      }
    });
  }

  async delete(externalId: string): Promise<AdapterResult<void>> {
    return this.safe(async () => {
      try {
        await this.scimRequest<void>('DELETE', `/Users/${externalId}`);
        logger.info({ externalId }, 'Zoho user deleted');
      } catch (err) {
        if (err instanceof ZohoNotFoundError) {
          logger.warn({ externalId }, 'Zoho delete: user not found, treating as gone');
          return;
        }
        throw err;
      }
    });
  }

  /**
   * Revoke Zoho OAuth2 token associated with the user.
   * Zoho does not expose a per-user token list via SCIM; we call the
   * revocation endpoint directly with a DELETE.
   */
  async revokeTokens(externalId: string): Promise<AdapterResult<void>> {
    return this.safe(async () => {
      try {
        await this.scimRequest<void>('DELETE', `/token/${externalId}`);
        logger.info({ externalId }, 'Zoho token revoked');
      } catch (err) {
        if (err instanceof ZohoNotFoundError) {
          logger.warn({ externalId }, 'Zoho revokeTokens: token not found (may have expired)');
          return;
        }
        throw err;
      }
    });
  }

  /**
   * List Zoho groups the user belongs to using SCIM filter.
   */
  async listBindings(externalId: string): Promise<AdapterResult<Binding[]>> {
    return this.safe(async () => {
      const encodedFilter = encodeURIComponent(`members[value eq "${externalId}"]`);
      const res = await this.scimRequest<ScimListResponse<ScimGroup>>(
        'GET',
        `/Groups?filter=${encodedFilter}&count=100`,
      );

      const bindings: Binding[] = (res.Resources ?? []).map((g) => ({
        id:   g.id,
        name: g.displayName,
        type: 'ZOHO_GROUP',
      }));

      return bindings;
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
class ZohoNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZohoNotFoundError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
