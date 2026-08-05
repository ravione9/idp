/**
 * Notification Service
 * --------------------
 * Outbox for EMAIL / SLACK / TEAMS / IN_APP, plus transactional email helper
 * used by MFA Email OTP (sends immediately; audit row never stores the OTP code).
 */

import https from 'https';
import { query, execute } from '../db/connection.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger.js';
import { getMfaDeliveryConfig } from './mfa-delivery-config.js';

export interface NotificationParams {
  recipientEmpId: string;
  channel: 'EMAIL' | 'SLACK' | 'TEAMS' | 'IN_APP';
  subject: string;
  body: string;
  templateId?: string;
  referenceId?: string;
  referenceType?: string;
}

interface NotificationRow {
  id: string;
  recipient_emp_id: string;
  channel: string;
  subject: string;
  body: string;
  status: string;
}

async function dispatchEmailViaApi(
  recipientEmail: string,
  subject: string,
  body: string,
  apiUrl: string,
  apiKey: string,
  from: string,
): Promise<void> {
  const resp = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      to: recipientEmail,
      subject,
      body,
      from: from || 'noreply@lenskart.com',
    }),
  });
  if (!resp.ok) {
    throw new Error(`Email API returned ${resp.status}`);
  }
}

/** Send email via configured API or SMTP (no DB write). */
export async function deliverEmail(
  recipientEmail: string,
  subject: string,
  body: string,
): Promise<void> {
  if (!recipientEmail?.trim()) {
    throw new Error('No recipient email address');
  }

  const cfg = await getMfaDeliveryConfig();

  if (cfg.emailTransport === 'api') {
    if (!cfg.emailApi.apiUrl) {
      throw new Error('Email API is not configured — set Email OTP delivery in Admin → MFA Methods');
    }
    await dispatchEmailViaApi(
      recipientEmail,
      subject,
      body,
      cfg.emailApi.apiUrl,
      cfg.emailApi.apiKey,
      cfg.emailApi.from || cfg.smtp.from,
    );
    return;
  }

  const { smtp } = cfg;
  if (!smtp.host) {
    throw new Error('SMTP is not configured — set Email OTP delivery in Admin → MFA Methods');
  }

  const nodemailer = await import('nodemailer');
  const transporter = nodemailer.default.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    requireTLS: !smtp.secure && smtp.port === 587,
    auth: smtp.user
      ? { user: smtp.user, pass: smtp.pass }
      : undefined,
    // Sandbox untrusted message fields (attachments/paths/URLs) if ever passed.
    disableFileAccess: true,
    disableUrlAccess:  true,
  });

  await transporter.sendMail({
    from: smtp.from || 'noreply@lenskart.com',
    to: recipientEmail,
    subject,
    text: body,
    disableFileAccess: true,
    disableUrlAccess:  true,
  });
}

async function dispatchSlack(body: string, subject: string): Promise<void> {
  const webhookUrl = process.env['SLACK_WEBHOOK_URL'];
  if (!webhookUrl) {
    throw new Error('SLACK_WEBHOOK_URL not configured');
  }

  const payload = JSON.stringify({ text: `*${subject}*\n${body}` });
  const url = new URL(webhookUrl);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        if ((res.statusCode ?? 0) >= 400) {
          reject(new Error(`Slack webhook returned ${res.statusCode}`));
        } else {
          resolve();
        }
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function dispatchTeams(body: string, subject: string): Promise<void> {
  const webhookUrl = process.env['TEAMS_WEBHOOK_URL'];
  if (!webhookUrl) {
    throw new Error('TEAMS_WEBHOOK_URL not configured');
  }

  const payload = JSON.stringify({
    '@type': 'MessageCard',
    '@context': 'http://schema.org/extensions',
    summary: subject,
    text: body,
  });
  const url = new URL(webhookUrl);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        if ((res.statusCode ?? 0) >= 400) {
          reject(new Error(`Teams webhook returned ${res.statusCode}`));
        } else {
          resolve();
        }
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function attemptDispatch(
  notificationId: string,
  channel: string,
  subject: string,
  body: string,
  recipientEmail: string,
): Promise<void> {
  try {
    if (channel === 'EMAIL') {
      await deliverEmail(recipientEmail, subject, body);
    } else if (channel === 'SLACK') {
      await dispatchSlack(body, subject);
    } else if (channel === 'TEAMS') {
      await dispatchTeams(body, subject);
    }

    await execute(
      `UPDATE notifications SET status = 'SENT', sent_at = UTC_TIMESTAMP() WHERE id = ?`,
      [notificationId],
    );
    logger.debug({ notificationId, channel }, 'Notification sent');
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await execute(
      `UPDATE notifications SET status = 'FAILED', error = ?, last_error = ? WHERE id = ?`,
      [errorMsg, errorMsg, notificationId],
    ).catch(async () => {
      await execute(
        `UPDATE notifications SET status = 'FAILED', error = ? WHERE id = ?`,
        [errorMsg, notificationId],
      );
    });
    logger.warn({ notificationId, channel, error: errorMsg }, 'Notification dispatch failed');
  }
}

/**
 * Record + dispatch a notification.
 * Populates both modern (011) and legacy (003) columns so inserts never fail on NOT NULL.
 */
export async function sendNotification(params: NotificationParams): Promise<void> {
  const emp = await query<{ email_corp: string }>(
    `SELECT email_corp FROM employees WHERE emp_id = ?`,
    [params.recipientEmpId],
  );
  const recipientEmail = emp[0]?.email_corp?.trim() ?? '';

  if (params.channel === 'EMAIL' && !recipientEmail) {
    throw new Error('Employee has no corporate email on file');
  }

  const notificationId = uuidv4();
  const template = params.templateId || params.referenceType || 'generic';
  const payload = JSON.stringify({
    subject: params.subject,
    body: params.body,
    referenceType: params.referenceType ?? null,
    referenceId: params.referenceId ?? null,
  });

  // Map service channel to DB enum (legacy used INAPP)
  const channelDb = params.channel === 'IN_APP' ? 'IN_APP' : params.channel;

  await execute(
    `INSERT INTO notifications
       (id, recipient_emp_id, recipient, channel, subject, body,
        template, template_id, payload, reference_id, reference_type,
        status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', UTC_TIMESTAMP())`,
    [
      notificationId,
      params.recipientEmpId,
      recipientEmail || params.recipientEmpId,
      channelDb,
      params.subject,
      params.body,
      template,
      params.templateId ?? null,
      payload,
      params.referenceId ?? null,
      params.referenceType ?? null,
    ],
  );

  await attemptDispatch(notificationId, params.channel, params.subject, params.body, recipientEmail);
}

/**
 * Transactional email for MFA OTP — delivers immediately once.
 * Writes a SENT audit row without the OTP code (never re-dispatches).
 */
export async function sendTransactionalEmail(params: {
  recipientEmpId: string;
  toEmail: string;
  subject: string;
  body: string;
  referenceType?: string;
  auditBody?: string;
}): Promise<void> {
  await deliverEmail(params.toEmail, params.subject, params.body);

  const auditBody = params.auditBody
    ?? 'A one-time verification code was sent to your email. The code is not stored in this log.';
  const notificationId = uuidv4();
  const template = 'mfa_email_otp';
  const payload = JSON.stringify({
    subject: params.subject,
    auditOnly: true,
    referenceType: params.referenceType ?? 'MFA_EMAIL_OTP',
  });

  try {
    await execute(
      `INSERT INTO notifications
         (id, recipient_emp_id, recipient, channel, subject, body,
          template, template_id, payload, reference_type,
          status, created_at, sent_at)
       VALUES (?, ?, ?, 'EMAIL', ?, ?, ?, ?, ?, ?,
               'SENT', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
      [
        notificationId,
        params.recipientEmpId,
        params.toEmail,
        params.subject,
        auditBody,
        template,
        template,
        payload,
        params.referenceType ?? 'MFA_EMAIL_OTP',
      ],
    );
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), empId: params.recipientEmpId },
      'MFA email sent but notification audit row failed',
    );
  }
}

export async function dispatchPendingNotifications(): Promise<number> {
  const pending = await query<NotificationRow & { email_corp: string | null; recipient?: string | null }>(
    `SELECT n.id, n.recipient_emp_id, n.channel, n.subject, n.body, n.status,
            e.email_corp, n.recipient
       FROM notifications n
       LEFT JOIN employees e ON e.emp_id = n.recipient_emp_id
      WHERE n.status = 'PENDING'
      ORDER BY n.created_at ASC
      LIMIT 50`,
    [],
  );

  if (pending.length === 0) return 0;

  let dispatched = 0;
  for (const notification of pending) {
    const email = notification.email_corp || notification.recipient || '';
    await attemptDispatch(
      notification.id,
      notification.channel,
      notification.subject,
      notification.body,
      email,
    );
    dispatched += 1;
  }

  logger.info({ dispatched }, 'Pending notifications dispatched');
  return dispatched;
}
