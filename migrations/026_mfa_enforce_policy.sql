-- 026_mfa_enforce_policy.sql
-- Add per-user MFA enforcement flag and global enforcement settings.
-- Idempotent: uses IF NOT EXISTS / ignored-error ALTER.

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS mfa_enforced TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = MFA required for this user regardless of global policy',
  ADD COLUMN IF NOT EXISTS mfa_enforced_at DATETIME DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS mfa_enforced_by VARCHAR(20) DEFAULT NULL;

CREATE TABLE IF NOT EXISTS mfa_policy (
  id              BIGINT      NOT NULL AUTO_INCREMENT,
  policy_key      VARCHAR(80) NOT NULL,
  policy_value    TEXT        NOT NULL,
  updated_at      DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by      VARCHAR(20) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_mfa_policy_key (policy_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed defaults (safe to re-run)
INSERT IGNORE INTO mfa_policy (policy_key, policy_value) VALUES
  ('global_enforce',       '0'),
  ('enforce_for_admins',   '1'),
  ('grace_period_hours',   '24'),
  ('allowed_methods',      '["totp","backup_codes"]');
