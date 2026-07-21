/**
 * Notification Service
 * --------------------
 * Inserts notification records and dispatches them via EMAIL, SLACK, TEAMS, or IN_APP.
 * EMAIL uses nodemailer (dynamically imported), SLACK uses the webhook URL,
 * IN_APP is marked SENT immediately. Undeliverable items remain PENDING for retry.
 */

import https from 'https';
import { query, execute } from '../db/connection.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger.js';
import { getMfaDeliveryConfig } from './mfa-delivery-config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Internal dispatch helpers
// ---------------------------------------------------------------------------

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

async function dispatchEmail(
  recipientEmail: string,
  subject: string,
  body: string,
): Promise<void> {
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

  // Dynamic import to avoid hard dependency if SMTP is not used
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodemailer = await import('nodemailer' as any) as any;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  const transporter = nodemailer.default.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user
      ? { user: smtp.user, pass: smtp.pass }
      : undefined,
  });

  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  await transporter.sendMail({
    from: smtp.from || 'noreply@lenskart.com',
    to:   recipientEmail,
    subject,
    text: body,
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
        path:     url.pathname + url.search,
        method:   'POST',
        headers: {
          'Content-Type':   'application/json',
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
    '@type':    'MessageCard',
    '@context': 'http://schema.org/extensions',
    summary:    subject,
    text:       body,
  });
  const url = new URL(webhookUrl);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        path:     url.pathname + url.search,
        method:   'POST',
        headers: {
          'Content-Type':   'application/json',
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
      await dispatchEmail(recipientEmail, subject, body);
    } else if (channel === 'SLACK') {
      await dispatchSlack(body, subject);
    } else if (channel === 'TEAMS') {
      await dispatchTeams(body, subject);
    }
    // IN_APP: just mark as sent (no external delivery needed)

    await execute(
      `UPDATE notifications SET status = 'SENT', sent_at = UTC_TIMESTAMP() WHERE id = ?`,
      [notificationId],
    );
    logger.debug({ notificationId, channel }, 'Notification sent');
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await execute(
      `UPDATE notifications SET status = 'FAILED', error = ? WHERE id = ?`,
      [errorMsg, notificationId],
    );
    logger.warn({ notificationId, channel, error: errorMsg }, 'Notification dispatch failed');
  }
}

// ---------------------------------------------------------------------------
// sendNotification
// ---------------------------------------------------------------------------
export async function sendNotification(params: NotificationParams): Promise<void> {
  // Get recipient email
  const emp = await query<{ email_corp: string }>(
    `SELECT email_corp FROM employees WHERE emp_id = ?`,
    [params.recipientEmpId],
  );
  const recipientEmail = emp[0]?.email_corp ?? '';

  const notificationId = uuidv4();

  // Insert notification record
  await execute(
    `INSERT INTO notifications
       (id, recipient_emp_id, channel, subject, body, template_id, reference_id,
        reference_type, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', UTC_TIMESTAMP())`,
    [
      notificationId,
      params.recipientEmpId,
      params.channel,
      params.subject,
      params.body,
      params.templateId ?? null,
      params.referenceId ?? null,
      params.referenceType ?? null,
    ],
  );

  // Attempt immediate dispatch
  await attemptDispatch(notificationId, params.channel, params.subject, params.body, recipientEmail);
}

// ---------------------------------------------------------------------------
// dispatchPendingNotifications
// ---------------------------------------------------------------------------
export async function dispatchPendingNotifications(): Promise<number> {
  const pending = await query<NotificationRow & { email_corp: string | null }>(
    `SELECT n.id, n.recipient_emp_id, n.channel, n.subject, n.body, n.status,
            e.email_corp
       FROM notifications n
       LEFT JOIN employees e ON e.emp_id = n.recipient_emp_id
      WHERE n.status = 'PENDING'
      ORDER BY n.created_at ASC
      LIMIT 50`,
    [],
  );

  if (pending.length === 0) {
    return 0;
  }

  let dispatched = 0;

  for (const notification of pending) {
    await attemptDispatch(
      notification.id,
      notification.channel,
      notification.subject,
      notification.body,
      notification.email_corp ?? '',
    );
    dispatched++;
  }

  logger.info({ dispatched }, 'Pending notifications dispatched');
  return dispatched;
}
