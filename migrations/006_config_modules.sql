-- 006: Groups, Identity Profiles, Adaptive Auth, Password Policies,
--      Branding, General Settings, PAM, Workflows, Event Triggers,
--      System Users, Tickets, SoD policy authoring

-- ── GROUPS ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `groups` (
  `id`           VARCHAR(36) NOT NULL PRIMARY KEY,
  `name`         VARCHAR(100) NOT NULL,
  `description`  TEXT,
  `type`         ENUM('STATIC','DYNAMIC') NOT NULL DEFAULT 'STATIC',
  `rule_json`    JSON COMMENT 'Dynamic group rule: { field, op, value }',
  `owner_emp_id` VARCHAR(20),
  `active`       TINYINT(1) NOT NULL DEFAULT 1,
  `created_by`   VARCHAR(20),
  `created_at`   DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
  `updated_at`   DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
  UNIQUE KEY `uq_group_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `group_members` (
  `id`       BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `group_id` VARCHAR(36) NOT NULL,
  `emp_id`   VARCHAR(20) NOT NULL,
  `added_at` DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
  `added_by` VARCHAR(20),
  UNIQUE KEY `uq_gm` (`group_id`, `emp_id`),
  INDEX `idx_gm_emp` (`emp_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── IDENTITY PROFILES ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `identity_profiles` (
  `id`                  VARCHAR(36) NOT NULL PRIMARY KEY,
  `name`                VARCHAR(100) NOT NULL,
  `description`         TEXT,
  `population`          ENUM('EMPLOYEE','CONTRACTOR','PARTNER','CUSTOMER','SERVICE') NOT NULL DEFAULT 'EMPLOYEE',
  `source_system`       VARCHAR(80) COMMENT 'HRMS, manual, contractor-portal, etc.',
  `attribute_map_json`  JSON COMMENT 'Source attribute → IdP attribute mapping',
  `lifecycle_policy`    JSON COMMENT 'ilg_state transitions config',
  `birthright_rule`     TEXT COMMENT 'SQL-style predicate for birthright assignment',
  `active`              TINYINT(1) NOT NULL DEFAULT 1,
  `created_by`          VARCHAR(20),
  `created_at`          DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
  `updated_at`          DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP())
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── ADAPTIVE AUTH POLICIES ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `adaptive_auth_policies` (
  `id`                VARCHAR(36) NOT NULL PRIMARY KEY,
  `name`              VARCHAR(100) NOT NULL,
  `description`       TEXT,
  `priority`          INT NOT NULL DEFAULT 100 COMMENT 'Lower = evaluated first',
  `conditions_json`   JSON NOT NULL COMMENT 'Array of condition objects: {type, op, value}',
  `action`            ENUM('ALLOW','MFA','DENY','BLOCK') NOT NULL DEFAULT 'MFA',
  `scope`             ENUM('ALL','APP_SPECIFIC','USER_GROUP') NOT NULL DEFAULT 'ALL',
  `app_ids_json`      JSON COMMENT 'App IDs when scope=APP_SPECIFIC',
  `group_ids_json`    JSON COMMENT 'Group IDs when scope=USER_GROUP',
  `active`            TINYINT(1) NOT NULL DEFAULT 1,
  `created_by`        VARCHAR(20),
  `created_at`        DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
  `updated_at`        DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP())
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── PASSWORD POLICIES ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `password_policies` (
  `id`                   VARCHAR(36) NOT NULL PRIMARY KEY,
  `name`                 VARCHAR(100) NOT NULL,
  `min_length`           INT NOT NULL DEFAULT 10,
  `require_uppercase`    TINYINT(1) NOT NULL DEFAULT 1,
  `require_lowercase`    TINYINT(1) NOT NULL DEFAULT 1,
  `require_digits`       TINYINT(1) NOT NULL DEFAULT 1,
  `require_special`      TINYINT(1) NOT NULL DEFAULT 0,
  `history_count`        INT NOT NULL DEFAULT 5 COMMENT 'Cannot reuse last N passwords',
  `max_age_days`         INT NOT NULL DEFAULT 90 COMMENT '0 = never expires',
  `lockout_attempts`     INT NOT NULL DEFAULT 10,
  `lockout_duration_min` INT NOT NULL DEFAULT 30,
  `breach_check`         TINYINT(1) NOT NULL DEFAULT 0,
  `is_default`           TINYINT(1) NOT NULL DEFAULT 0,
  `created_by`           VARCHAR(20),
  `created_at`           DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
  `updated_at`           DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP())
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed default password policy
INSERT IGNORE INTO `password_policies`
  (`id`, `name`, `min_length`, `require_uppercase`, `require_lowercase`, `require_digits`, `require_special`, `history_count`, `max_age_days`, `lockout_attempts`, `lockout_duration_min`, `is_default`)
VALUES
  (UUID(), 'Default Policy', 10, 1, 1, 1, 0, 5, 90, 10, 30, 1);

-- ── BRANDING SETTINGS ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `branding_settings` (
  `id`              INT NOT NULL PRIMARY KEY DEFAULT 1 COMMENT 'Singleton row',
  `org_name`        VARCHAR(150) NOT NULL DEFAULT 'Lenskart',
  `logo_url`        TEXT,
  `favicon_url`     TEXT,
  `accent_color`    VARCHAR(20) DEFAULT '#2563eb',
  `login_hero_title` VARCHAR(200) DEFAULT 'Welcome back',
  `login_hero_sub`  VARCHAR(400) DEFAULT 'Sign in to your Lenskart account',
  `login_bg_url`    TEXT,
  `support_email`   VARCHAR(150),
  `support_url`     TEXT,
  `tos_url`         TEXT,
  `privacy_url`     TEXT,
  `custom_css`      TEXT,
  `updated_by`      VARCHAR(20),
  `updated_at`      DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP())
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO `branding_settings` (`id`, `org_name`) VALUES (1, 'Lenskart');

-- ── GENERAL SETTINGS ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `general_settings` (
  `id`                     INT NOT NULL PRIMARY KEY DEFAULT 1 COMMENT 'Singleton row',
  `display_name`           VARCHAR(200) DEFAULT 'Lenskart IdP',
  `support_email`          VARCHAR(150),
  `default_session_hours`  INT NOT NULL DEFAULT 8,
  `session_absolute_hours` INT NOT NULL DEFAULT 24,
  `password_min_length`    INT NOT NULL DEFAULT 10,
  `mfa_grace_period_days`  INT NOT NULL DEFAULT 14,
  `audit_retention_days`   INT NOT NULL DEFAULT 365,
  `allow_google_login`     TINYINT(1) NOT NULL DEFAULT 1,
  `allow_local_login`      TINYINT(1) NOT NULL DEFAULT 1,
  `maintenance_mode`       TINYINT(1) NOT NULL DEFAULT 0,
  `maintenance_msg`        TEXT,
  `updated_by`             VARCHAR(20),
  `updated_at`             DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP())
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO `general_settings` (`id`) VALUES (1);

-- ── PAM RESOURCES ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `pam_resources` (
  `id`            VARCHAR(36) NOT NULL PRIMARY KEY,
  `name`          VARCHAR(150) NOT NULL,
  `type`          ENUM('SSH','RDP','DATABASE','WEB','WINDOWS') NOT NULL,
  `hostname`      VARCHAR(255),
  `port`          INT,
  `username`      VARCHAR(100) COMMENT 'Service account for this resource',
  `description`   TEXT,
  `tags`          JSON,
  `access_policy` ENUM('REQUEST','DIRECT','DENIED') NOT NULL DEFAULT 'REQUEST',
  `record_sessions` TINYINT(1) NOT NULL DEFAULT 1,
  `jit_enabled`   TINYINT(1) NOT NULL DEFAULT 1,
  `active`        TINYINT(1) NOT NULL DEFAULT 1,
  `created_by`    VARCHAR(20),
  `created_at`    DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
  `updated_at`    DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP())
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── PAM SESSIONS ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `pam_sessions` (
  `id`           VARCHAR(36) NOT NULL PRIMARY KEY,
  `resource_id`  VARCHAR(36) NOT NULL,
  `emp_id`       VARCHAR(20) NOT NULL,
  `started_at`   DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
  `ended_at`     DATETIME,
  `status`       ENUM('ACTIVE','ENDED','TERMINATED') NOT NULL DEFAULT 'ACTIVE',
  `justification` TEXT,
  `approved_by`  VARCHAR(20),
  `recording_url` TEXT,
  INDEX `idx_pam_emp`      (`emp_id`),
  INDEX `idx_pam_resource` (`resource_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── CREDENTIAL VAULT ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `credential_vault_entries` (
  `id`              VARCHAR(36) NOT NULL PRIMARY KEY,
  `name`            VARCHAR(150) NOT NULL,
  `type`            ENUM('PASSWORD','SSH_KEY','API_TOKEN','DATABASE','CERTIFICATE') NOT NULL DEFAULT 'PASSWORD',
  `resource_id`     VARCHAR(36),
  `username`        VARCHAR(100),
  `encrypted_secret` TEXT NOT NULL COMMENT 'AES-256-GCM encrypted, KMS-rooted',
  `rotation_days`   INT NOT NULL DEFAULT 90,
  `last_rotated_at` DATETIME,
  `next_rotation_at` DATETIME,
  `owner_emp_id`    VARCHAR(20),
  `access_policy`   JSON COMMENT 'Who can check out this credential',
  `active`          TINYINT(1) NOT NULL DEFAULT 1,
  `created_by`      VARCHAR(20),
  `created_at`      DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
  `updated_at`      DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP())
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── EVENT TRIGGERS ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `event_triggers` (
  `id`              VARCHAR(36) NOT NULL PRIMARY KEY,
  `event_type`      VARCHAR(80) NOT NULL COMMENT 'e.g. user.created, user.suspended, mfa.enrolled',
  `name`            VARCHAR(150) NOT NULL,
  `description`     TEXT,
  `filter_json`     JSON COMMENT 'Optional filter expressions',
  `action_type`     ENUM('WEBHOOK','SLACK','EMAIL','WORKFLOW') NOT NULL,
  `action_config`   JSON NOT NULL COMMENT 'url, headers, body template, etc.',
  `active`          TINYINT(1) NOT NULL DEFAULT 1,
  `last_fired_at`   DATETIME,
  `fire_count`      BIGINT NOT NULL DEFAULT 0,
  `created_by`      VARCHAR(20),
  `created_at`      DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
  `updated_at`      DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP())
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── TICKETS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `tickets` (
  `id`           VARCHAR(36) NOT NULL PRIMARY KEY,
  `category`     ENUM('PASSWORD_RESET','MFA_RESET','ACCESS_REQUEST','ACCOUNT_ISSUE','OTHER') NOT NULL,
  `subject`      VARCHAR(300) NOT NULL,
  `description`  TEXT,
  `requester_id` VARCHAR(20) NOT NULL,
  `assignee_id`  VARCHAR(20),
  `status`       ENUM('OPEN','IN_PROGRESS','RESOLVED','CLOSED') NOT NULL DEFAULT 'OPEN',
  `priority`     ENUM('LOW','MEDIUM','HIGH','CRITICAL') NOT NULL DEFAULT 'MEDIUM',
  `resolution`   TEXT,
  `created_at`   DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
  `updated_at`   DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
  INDEX `idx_ticket_req` (`requester_id`),
  INDEX `idx_ticket_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── SYSTEM USERS ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `system_users` (
  `id`                VARCHAR(36) NOT NULL PRIMARY KEY,
  `name`              VARCHAR(150) NOT NULL,
  `type`              ENUM('SERVICE_ACCOUNT','API_CLIENT','ROBOT','SHARED') NOT NULL,
  `owner_emp_id`      VARCHAR(20),
  `description`       TEXT,
  `source_system`     VARCHAR(80),
  `last_seen_at`      DATETIME,
  `credential_id`     VARCHAR(36) COMMENT 'Link to credential_vault_entries',
  `rotation_required` TINYINT(1) NOT NULL DEFAULT 0,
  `active`            TINYINT(1) NOT NULL DEFAULT 1,
  `created_at`        DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
  `updated_at`        DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP())
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
