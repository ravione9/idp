-- 012: Portal SSL certificate storage + HTTP/HTTPS connection settings
-- Adds columns to the general_settings singleton row.
-- portal_ssl_key stores the private key — restrict DB user perms in production.

ALTER TABLE `general_settings`
  ADD COLUMN IF NOT EXISTS `portal_ssl_cert`      MEDIUMTEXT   COMMENT 'PEM certificate for portal HTTPS',
  ADD COLUMN IF NOT EXISTS `portal_ssl_key`       MEDIUMTEXT   COMMENT 'PEM private key for portal HTTPS',
  ADD COLUMN IF NOT EXISTS `portal_ssl_ca`        MEDIUMTEXT   COMMENT 'PEM CA chain / intermediate cert (optional)',
  ADD COLUMN IF NOT EXISTS `portal_ssl_cn`        VARCHAR(255) COMMENT 'Cert CN, cached on upload',
  ADD COLUMN IF NOT EXISTS `portal_ssl_expiry`    DATETIME     COMMENT 'Cert expiry date, cached on upload',
  ADD COLUMN IF NOT EXISTS `portal_ssl_sans`      TEXT         COMMENT 'Subject Alternative Names, cached on upload',
  ADD COLUMN IF NOT EXISTS `portal_https_enabled` TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '1 = HTTPS server active',
  ADD COLUMN IF NOT EXISTS `portal_allow_http`    TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '0 = redirect all HTTP to HTTPS';
