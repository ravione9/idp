-- Personal credential vault for end users (owner-scoped; separate from PAM vault).
-- Secrets sealed with AES-256-GCM via secret-box / SESSION_SECRET.
-- emp_id collation must match employees.emp_id (utf8mb4_unicode_ci) for the FK.

CREATE TABLE IF NOT EXISTS `user_vault_entries` (
  `id`               VARCHAR(36)  NOT NULL PRIMARY KEY,
  `emp_id`           VARCHAR(20)  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `name`             VARCHAR(150) NOT NULL,
  `type`             ENUM('PASSWORD','SSH_KEY','API_TOKEN','NOTE') NOT NULL DEFAULT 'PASSWORD',
  `username`         VARCHAR(100) DEFAULT NULL,
  `encrypted_secret` TEXT         NOT NULL COMMENT 'AES-256-GCM sealed via secret-box',
  `notes`            VARCHAR(500) DEFAULT NULL COMMENT 'Non-secret memo',
  `active`           TINYINT(1)   NOT NULL DEFAULT 1,
  `created_at`       DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
  `updated_at`       DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
  KEY `idx_user_vault_emp` (`emp_id`),
  CONSTRAINT `fk_user_vault_emp` FOREIGN KEY (`emp_id`) REFERENCES `employees` (`emp_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
