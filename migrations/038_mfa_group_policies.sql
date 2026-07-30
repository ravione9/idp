-- 038_mfa_group_policies.sql
-- Per-group MFA method policies (which methods members may enroll/use).
-- Idempotent.

CREATE TABLE IF NOT EXISTS mfa_group_policies (
  id               BIGINT       NOT NULL AUTO_INCREMENT,
  group_id         VARCHAR(36)  NOT NULL,
  allowed_methods  JSON         NOT NULL,
  enforce          TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '1 = MFA required for group members',
  active           TINYINT(1)   NOT NULL DEFAULT 1,
  notes            VARCHAR(500) DEFAULT NULL,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by       VARCHAR(64)  DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_mfa_group_policies_group (group_id),
  KEY idx_mfa_group_policies_active (active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
