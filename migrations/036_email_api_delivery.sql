-- 036: API-based email delivery for MFA Email OTP (+ notifications)
-- Allows Admin GUI to choose SMTP protocol or HTTP email API gateway.

ALTER TABLE `general_settings`
  ADD COLUMN `email_transport` VARCHAR(16) NOT NULL DEFAULT 'smtp'
    COMMENT 'smtp | api — how outbound email is sent',
  ADD COLUMN `email_api_url` VARCHAR(1000) NULL
    COMMENT 'HTTP email API — POST JSON { to, subject, body, from }',
  ADD COLUMN `email_api_key` TEXT NULL
    COMMENT 'Optional Bearer token for email API (never returned by API)';
