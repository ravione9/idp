-- 054: Policy evaluation mode — daily live punch vs consecutive-absence window.

SET @has_mode := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'attendance_iga_config' AND column_name = 'evaluation_mode'
);
SET @sql := IF(@has_mode = 0,
  'ALTER TABLE attendance_iga_config
     ADD COLUMN `evaluation_mode` ENUM(''DAILY_LIVE'',''CONSECUTIVE_ABSENT'') NOT NULL DEFAULT ''DAILY_LIVE'' AFTER `cutoff_time`',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
