/**
 * Password Writeback Service
 * --------------------------
 * Writes a new password to all active identity systems (AD, Google) for a given employee.
 * Logs each attempt to password_writeback_log.
 */

import { google } from 'googleapis';
import { Client, Attribute, Change } from 'ldapts';
import { config } from '../config.js';
import { query } from '../db/connection.js';
import logger from '../utils/logger.js';
import { getIdentityLinksForEmp } from '../utils/outbox.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface WritebackResult {
  system: 'AD' | 'GOOGLE' | 'ZOHO';
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Encode a plain-text password for the AD unicodePwd attribute (UTF-16LE, quoted) */
function encodeAdPassword(password: string): string {
  const quoted = `"${password}"`;
  const buf = Buffer.from(quoted, 'utf16le');
  return buf.toString('binary');
}

async function writebackToGoogle(externalId: string, newPassword: string): Promise<void> {
  const rawKey = config.google.saKeyJson;
  // Support both raw JSON and base64-encoded JSON
  let key: Record<string, string>;
  try {
    key = JSON.parse(rawKey) as Record<string, string>;
  } catch {
    key = JSON.parse(Buffer.from(rawKey, 'base64').toString('utf8')) as Record<string, string>;
  }

  const auth = new google.auth.JWT({
    email:   key['client_email'],
    key:     key['private_key'],
    scopes:  ['https://www.googleapis.com/auth/admin.directory.user'],
    subject: key['client_email'],
  });

  const directory = google.admin({ version: 'directory_v1', auth });

  await directory.users.update({
    userKey: externalId,
    requestBody: {
      password: newPassword,
      changePasswordAtNextLogin: false,
    },
  });
}

async function writebackToAD(empId: string, newPassword: string): Promise<void> {
  const client = new Client({
    url: config.ad.url,
    connectTimeout: 10_000,
    timeout: 15_000,
    tlsOptions: { rejectUnauthorized: process.env['NODE_ENV'] === 'production' },
  });

  await client.bind(config.ad.bindDn, config.ad.bindPassword);

  try {
    // Search for user by employeeID
    const result = await client.search(config.ad.baseDn, {
      scope: 'sub',
      filter: `(&(objectClass=user)(employeeID=${ldapEscape(empId)}))`,
      attributes: ['dn'],
    });

    if (result.searchEntries.length === 0) {
      throw new Error(`AD user not found for employeeID=${empId}`);
    }

    const dn = result.searchEntries[0].dn;
    const encodedPassword = encodeAdPassword(newPassword);

    const pwdChange = new Change({
      operation: 'replace',
      modification: new Attribute({
        type: 'unicodePwd',
        values: [encodedPassword],
      }),
    });

    await client.modify(dn, [pwdChange]);
    logger.info({ empId, dn }, 'AD password writeback successful');
  } finally {
    await client.unbind();
  }
}

/** Escape special characters in LDAP filter values (RFC 4515) */
function ldapEscape(value: string): string {
  return value.replace(/[\\*()\x00/]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
export async function writebackPassword(
  empId: string,
  newPassword: string,
  initiatedBy: string,
): Promise<WritebackResult[]> {
  const links = await getIdentityLinksForEmp(empId);
  const activeLinks = links.filter(
    (l) => l.status === 'ACTIVE' && (l.system === 'GOOGLE' || l.system === 'AD'),
  );

  if (activeLinks.length === 0) {
    logger.info({ empId }, 'Password writeback: no active identity links found');
    return [];
  }

  const results: WritebackResult[] = [];

  for (const link of activeLinks) {
    const system = link.system as 'AD' | 'GOOGLE';
    let status: 'SUCCESS' | 'FAILED' | 'SKIPPED' = 'SKIPPED';
    let error: string | undefined;

    try {
      if (system === 'GOOGLE') {
        await writebackToGoogle(link.external_id, newPassword);
        status = 'SUCCESS';
      } else if (system === 'AD') {
        await writebackToAD(empId, newPassword);
        status = 'SUCCESS';
      }
      logger.info({ empId, system, externalId: link.external_id }, 'Password writeback succeeded');
    } catch (err) {
      status = 'FAILED';
      error = err instanceof Error ? err.message : String(err);
      logger.error({ empId, system, externalId: link.external_id, err }, 'Password writeback failed');
    }

    // Log to password_writeback_log
    try {
      await query(
        `INSERT INTO password_writeback_log (emp_id, target_system, status, error, initiated_by)
         VALUES (?, ?, ?, ?, ?)`,
        [empId, system, status, error ?? null, initiatedBy],
      );
    } catch (logErr) {
      logger.warn({ empId, system, logErr }, 'Failed to insert password_writeback_log row');
    }

    results.push({ system, status, ...(error ? { error } : {}) });
  }

  return results;
}
