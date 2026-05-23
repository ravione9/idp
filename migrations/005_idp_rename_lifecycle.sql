-- 005_idp_rename_lifecycle.sql
-- Phase-2 service layer requires:
--   1. lilg_sessions  → idp_sessions (with backward-compatible view)
--   2. password_writeback_log + lifecycle_events tables
--   3. connectors table reshaped to match the new dispatcher:
--         column   `config` → `config_json`
--         enum     status   adds 'ACTIVE'  (legacy values kept)
--         enum     sync_mode adds 'FULL','INCREMENTAL','RECONCILE'
--         enum     connector_type adds 'GOOGLE' (alias for GOOGLE_WORKSPACE)
--   4. seed built-in Active Directory + Google Workspace connectors
--
-- All statements are idempotent (use IF EXISTS / IF NOT EXISTS / IGNORE).

-- =========================================================================
-- 1. Rename lilg_sessions → idp_sessions and create a back-compat VIEW so
--    older code (and pre-deploy bookmarks) keep working. Simple `SELECT *`
--    views are updatable in MySQL, so INSERT / UPDATE / DELETE through the
--    legacy name still hit the underlying table.
-- =========================================================================
DROP VIEW IF EXISTS `lilg_sessions`;

-- Only rename if the source table still has its old name.
SET @rename_needed := (
  SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'lilg_sessions'
);
SET @sql := IF(@rename_needed = 1,
               'RENAME TABLE `lilg_sessions` TO `idp_sessions`',
               'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE OR REPLACE VIEW `lilg_sessions` AS SELECT * FROM `idp_sessions`;

-- =========================================================================
-- 2. Lifecycle / writeback audit tables
-- =========================================================================
CREATE TABLE IF NOT EXISTS `password_writeback_log` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `emp_id`        VARCHAR(20) NOT NULL,
  `target_system` ENUM('AD','GOOGLE','ZOHO') NOT NULL,
  `status`        ENUM('SUCCESS','FAILED','SKIPPED') NOT NULL,
  `error`         TEXT DEFAULT NULL,
  `initiated_by`  VARCHAR(20) DEFAULT NULL,
  `ts`            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_pwd_emp` (`emp_id`),
  INDEX `idx_pwd_ts`  (`ts`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lifecycle_events` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `emp_id`       VARCHAR(20) NOT NULL,
  `event_type`   ENUM('SUSPEND','UNSUSPEND','TERMINATE','REHIRE','MOVER') NOT NULL,
  `old_state`    VARCHAR(30) DEFAULT NULL,
  `new_state`    VARCHAR(30) DEFAULT NULL,
  `reason`       TEXT DEFAULT NULL,
  `initiated_by` VARCHAR(20) NOT NULL,
  `ts`           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_lce_emp` (`emp_id`),
  INDEX `idx_lce_ts`  (`ts`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =========================================================================
-- 3. Reshape `connectors` for the new dispatcher.
--    Migration 003 created column `config` and stricter enums; the new
--    connector-dispatcher.ts uses `config_json`, status='ACTIVE' and
--    sync_mode IN ('FULL','INCREMENTAL','RECONCILE'). Each ALTER below is
--    guarded so re-running the migration is safe.
-- =========================================================================

-- 3a. Rename `config` → `config_json` if needed.
SET @needs_rename := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'connectors'
    AND column_name = 'config'
);
SET @sql := IF(@needs_rename = 1,
               'ALTER TABLE `connectors` CHANGE COLUMN `config` `config_json` JSON NOT NULL',
               'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3b. Add `config_json` if neither column exists (very fresh DB; safety net).
SET @has_json := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'connectors'
    AND column_name = 'config_json'
);
SET @sql := IF(@has_json = 0,
               'ALTER TABLE `connectors` ADD COLUMN `config_json` JSON NOT NULL',
               'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3c. Widen the status / sync_mode / connector_type enums. Always run —
--     ALTER TABLE … MODIFY is idempotent against an already-correct definition.
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.tables
   WHERE table_schema = DATABASE() AND table_name = 'connectors') = 1,
  "ALTER TABLE `connectors`
     MODIFY COLUMN `status` ENUM('CONFIGURED','CONNECTED','ACTIVE','ERROR','DISABLED')
       NOT NULL DEFAULT 'CONFIGURED',
     MODIFY COLUMN `sync_mode` ENUM('REALTIME','SCHEDULED','MANUAL','FULL','INCREMENTAL','RECONCILE')
       NOT NULL DEFAULT 'SCHEDULED',
     MODIFY COLUMN `connector_type` ENUM(
       'SCIM','REST','LDAP','GOOGLE','GOOGLE_WORKSPACE','ZOHO','SLACK','GITHUB',
       'AD','HRMS','AWS_IAM','AZURE_AD','OKTA','SALESFORCE','JDBC','CUSTOM'
     ) NOT NULL",
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- =========================================================================
-- 4. Seed built-in connectors (only if connectors table exists and these
--    slugs aren't already present).
-- =========================================================================
INSERT IGNORE INTO `connectors`
  (id, name, slug, connector_type, direction, sync_mode, sync_schedule,
   status, config_json, entitlement_rule, created_at, updated_at)
SELECT * FROM (
  SELECT
    UUID()                    AS id,
    'Active Directory'        AS name,
    'active-directory'        AS slug,
    'LDAP'                    AS connector_type,
    'BIDIRECTIONAL'           AS direction,
    'INCREMENTAL'             AS sync_mode,
    '0 2 * * *'               AS sync_schedule,
    'ACTIVE'                  AS status,
    JSON_OBJECT('type','AD','autoProvision',true,'autoDisable',true) AS config_json,
    JSON_OBJECT('all_active', true) AS entitlement_rule,
    UTC_TIMESTAMP()           AS created_at,
    UTC_TIMESTAMP()           AS updated_at
) AS seed_ad
WHERE EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = DATABASE() AND table_name = 'connectors');

INSERT IGNORE INTO `connectors`
  (id, name, slug, connector_type, direction, sync_mode, sync_schedule,
   status, config_json, entitlement_rule, created_at, updated_at)
SELECT * FROM (
  SELECT
    UUID()                    AS id,
    'Google Workspace'        AS name,
    'google-workspace'        AS slug,
    'GOOGLE'                  AS connector_type,
    'BIDIRECTIONAL'           AS direction,
    'INCREMENTAL'             AS sync_mode,
    '0 3 * * *'               AS sync_schedule,
    'ACTIVE'                  AS status,
    JSON_OBJECT('type','GOOGLE','autoProvision',true,'autoDisable',true) AS config_json,
    JSON_OBJECT('all_active', true) AS entitlement_rule,
    UTC_TIMESTAMP()           AS created_at,
    UTC_TIMESTAMP()           AS updated_at
) AS seed_google
WHERE EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = DATABASE() AND table_name = 'connectors');
