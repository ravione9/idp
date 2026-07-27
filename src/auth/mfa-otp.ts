/**
 * Email and SMS OTP for MFA enrollment and login verification.
 * Codes live in Redis (5 min TTL); at-rest storage is not required.
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { queryOne } from '../db/connection.js';
import { redis } from './session-store.js';
import logger from '../utils/logger.js';
import { sendNotification } from '../services/notification.js';
import { getMfaDeliveryConfig } from '../services/mfa-delivery-config.js';
import {
  isMethodAllowed,
  setMethodEnrollment,
  type MfaMethodKey,
} from './mfa-methods.js';

const OTP_PREFIX = 'lilg:mfa-otp:';
const OTP_SEND_PREFIX = 'lilg:mfa-otp-send:';
const OTP_TTL_S = 300;
const OTP_SEND_COOLDOWN_S = 60;

type OtpChannel = 'email_otp' | 'sms_otp';

function otpKey(empId: string, channel: OtpChannel, purpose: 'enroll' | 'login'): string {
  return `${OTP_PREFIX}${purpose}:${channel}:${empId}`;
}

function sendCooldownKey(empId: string, channel: OtpChannel): string {
  return `${OTP_SEND_PREFIX}${channel}:${empId}`;
}

function generateCode(): string {
  return String(crypto.randomInt(100000, 999999));
}

async function storeOtp(
  empId: string,
  channel: OtpChannel,
  purpose: 'enroll' | 'login',
  code: string,
): Promise<void> {
  const hash = await bcrypt.hash(code, 10);
  await redis.set(otpKey(empId, channel, purpose), hash, 'EX', OTP_TTL_S);
}

export async function verifyOtpCode(
  empId: string,
  channel: OtpChannel,
  code: string,
  purpose: 'enroll' | 'login' = 'login',
): Promise<boolean> {
  const raw = await redis.get(otpKey(empId, channel, purpose));
  if (!raw) return false;
  const ok = await bcrypt.compare(code, raw);
  if (ok) await redis.del(otpKey(empId, channel, purpose));
  return ok;
}

async function dispatchSms(phone: string, body: string): Promise<void> {
  const cfg = await getMfaDeliveryConfig();
  const url = cfg.sms.apiUrl;
  if (!url) {
    if (cfg.smsDevLog || cfg.otpDevLog) {
      logger.info({ phone, body }, 'SMS OTP (dev log — SMS gateway not set)');
      return;
    }
    throw new Error('SMS delivery is not configured — set SMS OTP delivery in Admin → MFA Methods');
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.sms.apiKey ? { Authorization: `Bearer ${cfg.sms.apiKey}` } : {}),
    },
    body: JSON.stringify({ to: phone, message: body }),
  });
  if (!resp.ok) {
    throw new Error(`SMS gateway returned ${resp.status}`);
  }
}

export async function sendEmailOtp(
  empId: string,
  purpose: 'enroll' | 'login',
): Promise<{ sent: boolean; devCode?: string }> {
  if (!(await isMethodAllowed('email_otp', empId))) {
    throw new Error('Email OTP is not enabled by policy');
  }

  const cooldown = await redis.get(sendCooldownKey(empId, 'email_otp'));
  if (cooldown) throw new Error('Please wait before requesting another code');

  const emp = await queryOne<{ email_corp: string }>(
    'SELECT email_corp FROM employees WHERE emp_id = ? LIMIT 1',
    [empId],
  );
  if (!emp?.email_corp) throw new Error('No corporate email on file');

  const code = generateCode();
  await storeOtp(empId, 'email_otp', purpose, code);
  await redis.set(sendCooldownKey(empId, 'email_otp'), '1', 'EX', OTP_SEND_COOLDOWN_S);

  const subject = purpose === 'enroll'
    ? 'Lenskart IdP — verify Email OTP enrollment'
    : 'Lenskart IdP — sign-in verification code';
  const body = `Your verification code is ${code}. It expires in 5 minutes. Do not share this code.`;

  const delivery = await getMfaDeliveryConfig();
  try {
    await sendNotification({
      recipientEmpId: empId,
      channel: 'EMAIL',
      subject,
      body,
      referenceType: 'MFA_EMAIL_OTP',
    });
  } catch (err) {
    const emailReady = delivery.emailTransport === 'api'
      ? Boolean(delivery.emailApi.apiUrl)
      : Boolean(delivery.smtp.host);
    if (emailReady) throw err;
    logger.warn({ empId, err }, 'Email OTP: email delivery not configured');
    if (delivery.otpDevLog || delivery.smsDevLog) {
      return { sent: true, devCode: code };
    }
    throw new Error('Email delivery is not configured — set Email OTP delivery in Admin → MFA Methods');
  }

  if (delivery.otpDevLog) {
    return { sent: true, devCode: code };
  }
  return { sent: true };
}

export async function sendSmsOtp(
  empId: string,
  purpose: 'enroll' | 'login',
): Promise<{ sent: boolean; devCode?: string; maskedPhone?: string }> {
  if (!(await isMethodAllowed('sms_otp', empId))) {
    throw new Error('SMS OTP is not enabled by policy');
  }

  const cooldown = await redis.get(sendCooldownKey(empId, 'sms_otp'));
  if (cooldown) throw new Error('Please wait before requesting another code');

  const emp = await queryOne<{ mobile: string | null }>(
    'SELECT mobile FROM employees WHERE emp_id = ? LIMIT 1',
    [empId],
  );
  const phone = emp?.mobile?.trim();
  if (!phone) throw new Error('No mobile number on file — update your profile or ask HR');

  const code = generateCode();
  await storeOtp(empId, 'sms_otp', purpose, code);
  await redis.set(sendCooldownKey(empId, 'sms_otp'), '1', 'EX', OTP_SEND_COOLDOWN_S);

  const body = `Lenskart IdP code: ${code}. Expires in 5 minutes.`;
  await dispatchSms(phone, body);

  const result: { sent: boolean; devCode?: string; maskedPhone?: string } = {
    sent: true,
    maskedPhone: phone.replace(/\d(?=\d{4})/g, '•'),
  };
  const delivery = await getMfaDeliveryConfig();
  if (delivery.otpDevLog || delivery.smsDevLog) {
    result.devCode = code;
  }
  return result;
}

export async function confirmEmailOtpEnrollment(empId: string, code: string): Promise<void> {
  const ok = await verifyOtpCode(empId, 'email_otp', code, 'enroll');
  if (!ok) throw new Error('Invalid or expired code');
  const emp = await queryOne<{ email_corp: string }>(
    'SELECT email_corp FROM employees WHERE emp_id = ? LIMIT 1',
    [empId],
  );
  await setMethodEnrollment(empId, 'email_otp', true, { email: emp?.email_corp ?? null });
  logger.info({ empId }, 'Email OTP MFA enrolled');
}

export async function confirmSmsOtpEnrollment(empId: string, code: string): Promise<void> {
  const ok = await verifyOtpCode(empId, 'sms_otp', code, 'enroll');
  if (!ok) throw new Error('Invalid or expired code');
  const emp = await queryOne<{ mobile: string | null }>(
    'SELECT mobile FROM employees WHERE emp_id = ? LIMIT 1',
    [empId],
  );
  await setMethodEnrollment(empId, 'sms_otp', true, { phone: emp?.mobile ?? null });
  logger.info({ empId }, 'SMS OTP MFA enrolled');
}

export async function isOtpMethodEnabled(empId: string, channel: OtpChannel): Promise<boolean> {
  const row = await queryOne<{ enabled: number }>(
    `SELECT enabled FROM mfa_method_enrollments WHERE emp_id = ? AND method = ? LIMIT 1`,
    [empId, channel],
  );
  return row?.enabled === 1;
}

/**
 * Accept login OTPs when the channel is allowed by policy.
 * Prior enrollment is not required — first successful use records enrollment.
 */
export async function verifyAnyOtpLogin(empId: string, code: string): Promise<MfaMethodKey | null> {
  if (await isMethodAllowed('email_otp', empId)) {
    if (await verifyOtpCode(empId, 'email_otp', code, 'login')) {
      if (!(await isOtpMethodEnabled(empId, 'email_otp'))) {
        const emp = await queryOne<{ email_corp: string }>(
          'SELECT email_corp FROM employees WHERE emp_id = ? LIMIT 1',
          [empId],
        );
        await setMethodEnrollment(empId, 'email_otp', true, { email: emp?.email_corp ?? null });
      }
      return 'email_otp';
    }
  }
  if (await isMethodAllowed('sms_otp', empId)) {
    if (await verifyOtpCode(empId, 'sms_otp', code, 'login')) {
      if (!(await isOtpMethodEnabled(empId, 'sms_otp'))) {
        const emp = await queryOne<{ mobile: string | null }>(
          'SELECT mobile FROM employees WHERE emp_id = ? LIMIT 1',
          [empId],
        );
        await setMethodEnrollment(empId, 'sms_otp', true, { phone: emp?.mobile ?? null });
      }
      return 'sms_otp';
    }
  }
  return null;
}

export async function disableOtpMethod(empId: string, channel: OtpChannel): Promise<void> {
  await setMethodEnrollment(empId, channel, false, null);
}
