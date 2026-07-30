-- 015_groups_collation_fix.sql
-- Migration 014 added connector_id / external_id with the server default collation
-- (utf8mb4_0900_ai_ci on MySQL 8). connectors.id uses utf8mb4_unicode_ci — JOINs fail
-- with ER_CANT_AGGREGATE_2COLLATIONS until these columns are aligned.

SET @has_connector := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'groups'
    AND column_name = 'connector_id'
);
SET @sql := IF(@has_connector > 0,
  'ALTER TABLE `groups`
     MODIFY COLUMN `connector_id` VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
     MODIFY COLUMN `external_id` VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT ''Google group email or AD group DN''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
