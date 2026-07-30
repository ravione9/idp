-- 035: MFA Email / SMS OTP delivery settings editable from Admin GUI
-- Stores SMTP + SMS gateway credentials in general_settings (singleton).
-- DB values take precedence over SMTP_* / SMS_* env vars when set.

ALTER TABLE `general_settings`
  ADD COLUMN `smtp_host` VARCHAR(255) NULL COMMENT 'SMTP host for email OTP + notifications',
  ADD COLUMN `smtp_port` INT NULL DEFAULT 587 COMMENT 'SMTP port',
  ADD COLUMN `smtp_user` VARCHAR(255) NULL COMMENT 'SMTP username',
  ADD COLUMN `smtp_pass` TEXT NULL COMMENT 'SMTP password (never returned by API)',
  ADD COLUMN `smtp_from` VARCHAR(255) NULL COMMENT 'From address for outbound mail',
  ADD COLUMN `smtp_secure` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = TLS/SSL (typically port 465)',
  ADD COLUMN `sms_api_url` VARCHAR(1000) NULL COMMENT 'SMS gateway URL — POST JSON { to, message }',
  ADD COLUMN `sms_api_key` TEXT NULL COMMENT 'Optional Bearer token for SMS gateway',
  ADD COLUMN `mfa_otp_dev_log` TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Dev: return OTP codes in API/logs',
  ADD COLUMN `sms_dev_log` TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Dev: log SMS when gateway unset';
