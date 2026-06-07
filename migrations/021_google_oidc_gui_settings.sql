-- 021: Google OIDC login settings editable from Admin GUI
-- Adds optional DB overrides for inbound Google login credentials.

ALTER TABLE `general_settings`
  ADD COLUMN `google_oidc_client_id` VARCHAR(255) NULL COMMENT 'Optional override for GOOGLE_CLIENT_ID',
  ADD COLUMN `google_oidc_client_secret` VARCHAR(255) NULL COMMENT 'Optional override for GOOGLE_CLIENT_SECRET',
  ADD COLUMN `google_oidc_hosted_domain` VARCHAR(255) NULL COMMENT 'Optional override for GOOGLE_HOSTED_DOMAIN';
