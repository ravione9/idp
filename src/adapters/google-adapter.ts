import { google, admin_directory_v1 } from 'googleapis';
import { JWT } from 'googleapis/build/src/auth/jwtclient.js';
import { Redis } from 'ioredis';
import { BaseAdapter, AdapterResult, UserInfo, Binding } from './base-adapter.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface GoogleToken {
  access_token: string;
  token_type: string;
  expiry_date: number;
}

// ---------------------------------------------------------------------------
// GoogleAdapter
// ---------------------------------------------------------------------------
export class GoogleAdapter extends BaseAdapter {
  private readonly directory: admin_directory_v1.Admin;
  private readonly auth: JWT;

  constructor(redis: Redis, saKeyJson: string, impersonateEmail?: string) {
    super(redis, 'GOOGLE');

    const key = JSON.parse(Buffer.from(saKeyJson, 'base64').toString('utf8'));

    this.auth = new google.auth.JWT({
      email:   key.client_email,
      key:     key.private_key,
      scopes:  [
        'https://www.googleapis.com/auth/admin.directory.user',
        'https://www.googleapis.com/auth/admin.directory.group.readonly',
      ],
      subject: impersonateEmail ?? key.client_email,
    });

    this.directory = google.admin({ version: 'directory_v1', auth: this.auth });
  }

  /**
   * Retrieve a Google Workspace user by their primary email or user key.
   */
  async getUser(externalId: string): Promise<AdapterResult<UserInfo>> {
    return this.safe(async () => {
      const res = await this.directory.users.get({ userKey: externalId });
      const u = res.data;

      return {
        externalId: u.id ?? externalId,
        email:       u.primaryEmail ?? externalId,
        displayName: u.name?.fullName ?? '',
        active:      !(u.suspended ?? false),
        googleId:    u.id,
        orgUnitPath: u.orgUnitPath,
        lastLoginTime: u.lastLoginTime,
        isAdmin:     u.isAdmin,
      };
    });
  }

  /**
   * Suspend the Google account and immediately invalidate all sign-in cookies.
   */
  async disable(externalId: string, _evidence?: Record<string, unknown>): Promise<AdapterResult<void>> {
    return this.safe(async () => {
      try {
        await this.directory.users.update({
          userKey:     externalId,
          requestBody: { suspended: true },
        });
        logger.info({ externalId }, 'Google user suspended');
      } catch (err: unknown) {
        if (this.isNotFound(err)) {
          logger.warn({ externalId }, 'Google disable: user not found, treating as already removed');
          return;
        }
        throw err;
      }

      // Sign out all active sessions (best-effort)
      try {
        await this.directory.users.signOut({ userKey: externalId });
        logger.info({ externalId }, 'Google user signed out of all sessions');
      } catch (err: unknown) {
        logger.warn({ externalId, err }, 'Google signOut failed after suspend (non-fatal)');
      }
    });
  }

  /**
   * Un-suspend the Google account.
   */
  async enable(externalId: string): Promise<AdapterResult<void>> {
    return this.safe(async () => {
      try {
        await this.directory.users.update({
          userKey:     externalId,
          requestBody: { suspended: false },
        });
        logger.info({ externalId }, 'Google user re-enabled');
      } catch (err: unknown) {
        if (this.isNotFound(err)) {
          logger.warn({ externalId }, 'Google enable: user not found');
          return;
        }
        throw err;
      }
    });
  }

  /**
   * Permanently delete a Google Workspace account.
   * Per Google policy, deleted accounts sit in trash for 20 days and can be
   * undeleted. LILG will not automatically undelete.
   */
  async delete(externalId: string): Promise<AdapterResult<void>> {
    return this.safe(async () => {
      try {
        await this.directory.users.delete({ userKey: externalId });
        logger.info({ externalId }, 'Google user deleted');
      } catch (err: unknown) {
        if (this.isNotFound(err)) {
          logger.warn({ externalId }, 'Google delete: user not found, treating as gone');
          return;
        }
        throw err;
      }
    });
  }

  /**
   * Revoke all OAuth2 access tokens issued to this user.
   * Uses the Admin SDK tokens resource to list and revoke each token.
   */
  async revokeTokens(externalId: string): Promise<AdapterResult<void>> {
    return this.safe(async () => {
      let pageToken: string | undefined;

      do {
        const listRes = await this.directory.tokens.list({
          userKey: externalId,
          ...(pageToken ? { pageToken } : {}),
        });

        const tokens = listRes.data.items ?? [];
        for (const token of tokens) {
          if (!token.clientId) continue;
          try {
            await this.directory.tokens.delete({
              userKey:  externalId,
              clientId: token.clientId,
            });
            logger.debug({ externalId, clientId: token.clientId }, 'Google OAuth token revoked');
          } catch (err: unknown) {
            logger.warn({ externalId, clientId: token.clientId, err }, 'Token revoke failed (non-fatal)');
          }
        }

        // tokens.list does not use standard pagination — only one page is returned
        pageToken = undefined;
      } while (pageToken);

      logger.info({ externalId }, 'Google OAuth tokens revoked');
    });
  }

  /**
   * List all Google Groups this user is a member of.
   */
  async listBindings(externalId: string): Promise<AdapterResult<Binding[]>> {
    return this.safe(async () => {
      const bindings: Binding[] = [];
      let pageToken: string | undefined;

      do {
        const res = await this.directory.groups.list({
          userKey:   externalId,
          maxResults: 200,
          ...(pageToken ? { pageToken } : {}),
        });

        for (const g of res.data.groups ?? []) {
          bindings.push({
            id:   g.id     ?? '',
            name: g.name   ?? '',
            type: 'GOOGLE_GROUP',
            scope: g.email ?? undefined,
          });
        }

        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken);

      return bindings;
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  private isNotFound(err: unknown): boolean {
    if (typeof err === 'object' && err !== null && 'code' in err) {
      return (err as { code: number }).code === 404;
    }
    return false;
  }
}
