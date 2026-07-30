-- 022_google_oidc_multi_domain.sql
-- Allow multiple Google Workspace domains in OIDC hosted-domain setting.

ALTER TABLE `general_settings`
  MODIFY COLUMN `google_oidc_hosted_domain` VARCHAR(1000) NULL
    COMMENT 'Allowed Google Workspace domains (comma or newline separated)';
