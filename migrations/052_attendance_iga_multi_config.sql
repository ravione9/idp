-- 052: Multiple Attendance IGA configs with department + employment-type scope.
-- Existing singleton row (id=1) becomes "Default"; rules/exclusions/runs get config_id.

SET @has_name := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'attendance_iga_config' AND column_name = 'name'
);
SET @sql := IF(@has_name = 0,
  'ALTER TABLE attendance_iga_config
     ADD COLUMN `name` VARCHAR(150) NOT NULL DEFAULT ''Default'' AFTER `id`,
     ADD COLUMN `slug` VARCHAR(80) NOT NULL DEFAULT ''default'' AFTER `name`,
     ADD COLUMN `employee_scope` JSON NULL AFTER `slug`',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE attendance_iga_config
   SET name = COALESCE(NULLIF(name, ''), 'Default'),
       slug = COALESCE(NULLIF(slug, ''), 'default')
 WHERE id = 1;

-- Allow multiple rows (id auto-increment)
ALTER TABLE attendance_iga_config MODIFY COLUMN `id` INT NOT NULL AUTO_INCREMENT;

SET @has_slug_uk := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'attendance_iga_config' AND index_name = 'uk_att_iga_slug'
);
SET @sql := IF(@has_slug_uk = 0,
  'ALTER TABLE attendance_iga_config ADD UNIQUE KEY `uk_att_iga_slug` (`slug`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Rules scoped per config
SET @has_rule_cfg := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'attendance_iga_rules' AND column_name = 'config_id'
);
SET @sql := IF(@has_rule_cfg = 0,
  'ALTER TABLE attendance_iga_rules ADD COLUMN `config_id` INT NOT NULL DEFAULT 1 AFTER `id`',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE attendance_iga_rules SET config_id = 1 WHERE config_id IS NULL OR config_id = 0;

SET @has_rule_uk := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'attendance_iga_rules' AND index_name = 'uk_att_rule_key'
);
SET @sql := IF(@has_rule_uk > 0,
  'ALTER TABLE attendance_iga_rules DROP INDEX `uk_att_rule_key`',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_rule_cfg_uk := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'attendance_iga_rules' AND index_name = 'uk_att_rule_config_key'
);
SET @sql := IF(@has_rule_cfg_uk = 0,
  'ALTER TABLE attendance_iga_rules ADD UNIQUE KEY `uk_att_rule_config_key` (`config_id`, `rule_key`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Exclusions scoped per config
SET @has_excl_cfg := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'attendance_iga_exclusions' AND column_name = 'config_id'
);
SET @sql := IF(@has_excl_cfg = 0,
  'ALTER TABLE attendance_iga_exclusions ADD COLUMN `config_id` INT NOT NULL DEFAULT 1 AFTER `id`',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE attendance_iga_exclusions SET config_id = 1 WHERE config_id IS NULL OR config_id = 0;

SET @has_excl_uk := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'attendance_iga_exclusions' AND index_name = 'uk_att_excl'
);
SET @sql := IF(@has_excl_uk > 0,
  'ALTER TABLE attendance_iga_exclusions DROP INDEX `uk_att_excl`',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_excl_cfg_uk := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'attendance_iga_exclusions' AND index_name = 'uk_att_excl_config'
);
SET @sql := IF(@has_excl_cfg_uk = 0,
  'ALTER TABLE attendance_iga_exclusions ADD UNIQUE KEY `uk_att_excl_config` (`config_id`, `exclusion_type`, `value`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Import runs track which config ran
SET @has_run_cfg := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'attendance_iga_import_runs' AND column_name = 'config_id'
);
SET @sql := IF(@has_run_cfg = 0,
  'ALTER TABLE attendance_iga_import_runs ADD COLUMN `config_id` INT NOT NULL DEFAULT 1 AFTER `id`',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE attendance_iga_import_runs SET config_id = 1 WHERE config_id IS NULL OR config_id = 0;

SET @has_run_idx := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'attendance_iga_import_runs' AND index_name = 'idx_att_run_config'
);
SET @sql := IF(@has_run_idx = 0,
  'ALTER TABLE attendance_iga_import_runs ADD KEY `idx_att_run_config` (`config_id`, `started_at`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
