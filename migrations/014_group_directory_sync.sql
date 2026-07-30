-- 014_group_directory_sync.sql
-- Link IdP groups to Google Workspace / Active Directory for membership sync.

SET @needs_source := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'groups'
    AND column_name = 'source_system'
);
SET @sql := IF(@needs_source = 0,
  'ALTER TABLE `groups`
     ADD COLUMN `source_system` ENUM(''LOCAL'',''GOOGLE'',''AD'') NOT NULL DEFAULT ''LOCAL'' AFTER `type`,
     ADD COLUMN `external_id` VARCHAR(512) DEFAULT NULL COMMENT ''Google group email or AD group DN'' AFTER `source_system`,
     ADD COLUMN `connector_id` VARCHAR(36) DEFAULT NULL AFTER `external_id`,
     ADD COLUMN `last_synced_at` DATETIME DEFAULT NULL AFTER `connector_id`',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @needs_idx := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'groups'
    AND index_name = 'idx_group_source'
);
SET @sql := IF(@needs_idx = 0,
  'CREATE INDEX idx_group_source ON `groups` (source_system, connector_id)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
