-- 009_identity_links.sql
-- Creates identity_links for Universal Directory / hybrid-identity (admin-users.ts,
-- ad-sync.ts, google-sync.ts). Matches src/db/schema.sql column definitions.
-- Idempotent: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS `identity_links` (
  `id`             BIGINT          NOT NULL AUTO_INCREMENT,
  `emp_id`         VARCHAR(20)     NOT NULL,
  `system`         ENUM(
                     'GOOGLE','ZOHO','SLACK','GITHUB','AD','HRMS',
                     'NEXSID','SALESMAN_OTP','BIGQUERY','AWS_IDC'
                   )               NOT NULL,
  `external_id`    VARCHAR(255)    NOT NULL,
  `status`         ENUM('ACTIVE','DISABLED','DELETED','ORPHAN') NOT NULL DEFAULT 'ACTIVE',
  `last_synced_at` DATETIME        DEFAULT NULL,
  `drift_flag`     TINYINT(1)      NOT NULL DEFAULT 0,
  `auth_kind`      ENUM('OIDC','SAML','LDAP','OTP','BIOMETRIC') NOT NULL DEFAULT 'LDAP',
  `created_at`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_system_external` (`system`, `external_id`),
  KEY `idx_emp_system` (`emp_id`, `system`),
  CONSTRAINT `fk_il_emp`
    FOREIGN KEY (`emp_id`) REFERENCES `employees` (`emp_id`)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
