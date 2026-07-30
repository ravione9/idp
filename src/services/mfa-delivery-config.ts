/**
 * MFA Email / SMS delivery configuration.
 * Prefers Admin GUI values in general_settings; falls back to env vars.
 */
import { queryOne } from '../db/connection.js';

export type DeliveryMode = 'smtp' | 'api' | 'gateway' | 'dev' | 'none';
export type EmailTransport = 'smtp' | 'api';

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  secure: boolean;
  source: 'db' | 'env' | 'none';
}

export interface EmailApiConfig {
  apiUrl: string;
  apiKey: string;
  from: string;
  source: 'db' | 'env' | 'none';
}

export interface SmsConfig {
  apiUrl: string;
  apiKey: string;
  source: 'db' | 'env' | 'none';
}

export interface MfaDeliveryConfig {
  emailTransport: EmailTransport;
  smtp: SmtpConfig;
  emailApi: EmailApiConfig;
  sms: SmsConfig;
  otpDevLog: boolean;
  smsDevLog: boolean;
  emailMode: DeliveryMode;
  smsMode: DeliveryMode;
}

type DeliveryRow = {
  email_transport: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_user: string | null;
  smtp_pass: string | null;
  smtp_from: string | null;
  smtp_secure: number | null;
  email_api_url: string | null;
  email_api_key: string | null;
  sms_api_url: string | null;
  sms_api_key: string | null;
  mfa_otp_dev_log: number | null;
  sms_dev_log: number | null;
};

function trim(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function pick(dbValue: string | null | undefined, envValue: string | undefined): { value: string; source: 'db' | 'env' | 'none' } {
  const db = trim(dbValue);
  if (db) return { value: db, source: 'db' };
  const env = trim(envValue);
  if (env) return { value: env, source: 'env' };
  return { value: '', source: 'none' };
}

export async function getMfaDeliveryConfig(): Promise<MfaDeliveryConfig> {
  let row: DeliveryRow | null = null;
  try {
    row = await queryOne<DeliveryRow>(
      `SELECT email_transport, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from, smtp_secure,
              email_api_url, email_api_key,
              sms_api_url, sms_api_key, mfa_otp_dev_log, sms_dev_log
         FROM general_settings
        WHERE id = 1`,
      [],
    );
  } catch {
    // Migration not applied yet — env only / older columns.
    try {
      row = await queryOne<DeliveryRow>(
        `SELECT smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from, smtp_secure,
                sms_api_url, sms_api_key, mfa_otp_dev_log, sms_dev_log
           FROM general_settings
          WHERE id = 1`,
        [],
      );
    } catch {
      row = null;
    }
  }

  const host = pick(row?.smtp_host, process.env['SMTP_HOST']);
  const user = pick(row?.smtp_user, process.env['SMTP_USER']);
  const pass = pick(row?.smtp_pass, process.env['SMTP_PASS']);
  const from = pick(row?.smtp_from, process.env['SMTP_FROM'] ?? 'noreply@lenskart.com');

  let port = 587;
  let secure = false;
  let smtpSource: 'db' | 'env' | 'none' = host.source;
  if (host.source === 'db' && row) {
    port = Number(row.smtp_port) > 0 ? Number(row.smtp_port) : 587;
    secure = row.smtp_secure === 1;
  } else if (host.source === 'env') {
    port = parseInt(process.env['SMTP_PORT'] ?? '587', 10) || 587;
    secure = process.env['SMTP_SECURE'] === 'true' || port === 465;
  }

  const emailApiUrl = pick(row?.email_api_url, process.env['EMAIL_API_URL']);
  const emailApiKey = pick(row?.email_api_key, process.env['EMAIL_API_KEY']);

  const smsUrl = pick(row?.sms_api_url, process.env['SMS_API_URL']);
  const smsKey = pick(row?.sms_api_key, process.env['SMS_API_KEY']);

  const otpDevLog = row?.mfa_otp_dev_log === 1 || process.env['MFA_OTP_DEV_LOG'] === 'true';
  const smsDevLog = row?.sms_dev_log === 1 || process.env['SMS_DEV_LOG'] === 'true';

  const dbTransport = trim(row?.email_transport).toLowerCase();
  let emailTransport: EmailTransport = dbTransport === 'api' ? 'api' : 'smtp';
  // Auto-detect API when GUI/env has API URL and no SMTP host
  if (dbTransport !== 'smtp' && dbTransport !== 'api') {
    if (emailApiUrl.value && !host.value) emailTransport = 'api';
  }

  const smtpConfigured = Boolean(host.value);
  const emailApiConfigured = Boolean(emailApiUrl.value);
  const smsConfigured = Boolean(smsUrl.value);

  let emailMode: DeliveryMode = 'none';
  if (emailTransport === 'api') {
    emailMode = emailApiConfigured ? 'api' : (otpDevLog ? 'dev' : 'none');
  } else {
    emailMode = smtpConfigured ? 'smtp' : (otpDevLog ? 'dev' : 'none');
  }
  const smsMode: DeliveryMode = smsConfigured ? 'gateway' : ((otpDevLog || smsDevLog) ? 'dev' : 'none');

  return {
    emailTransport,
    smtp: {
      host: host.value,
      port,
      user: user.value,
      pass: pass.value,
      from: from.value || 'noreply@lenskart.com',
      secure,
      source: smtpSource,
    },
    emailApi: {
      apiUrl: emailApiUrl.value,
      apiKey: emailApiKey.value,
      from: from.value || 'noreply@lenskart.com',
      source: emailApiUrl.source,
    },
    sms: {
      apiUrl: smsUrl.value,
      apiKey: smsKey.value,
      source: smsUrl.source,
    },
    otpDevLog,
    smsDevLog,
    emailMode,
    smsMode,
  };
}

export function publicDeliveryStatus(cfg: MfaDeliveryConfig) {
  const emailSource = cfg.emailTransport === 'api' ? cfg.emailApi.source : cfg.smtp.source;
  return {
    emailOtp: {
      ready: cfg.emailMode !== 'none',
      mode: cfg.emailMode,
      transport: cfg.emailTransport,
      smtpHost: cfg.smtp.host || null,
      smtpPort: cfg.smtp.port,
      smtpUser: cfg.smtp.user || null,
      smtpFrom: cfg.smtp.from || null,
      smtpSecure: cfg.smtp.secure,
      hasSmtpPass: Boolean(cfg.smtp.pass),
      emailApiUrl: cfg.emailApi.apiUrl || null,
      hasEmailApiKey: Boolean(cfg.emailApi.apiKey),
      source: emailSource,
      otpDevLog: cfg.otpDevLog,
    },
    smsOtp: {
      ready: cfg.smsMode !== 'none',
      mode: cfg.smsMode,
      smsApiUrl: cfg.sms.apiUrl || null,
      hasSmsApiKey: Boolean(cfg.sms.apiKey),
      source: cfg.sms.source,
      smsDevLog: cfg.smsDevLog,
      otpDevLog: cfg.otpDevLog,
    },
  };
}
