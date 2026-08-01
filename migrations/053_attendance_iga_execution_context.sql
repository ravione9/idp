-- 053: Persist absent-day count + attendance status on executions for Executions UI.

SET @has_absent := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'attendance_iga_executions' AND column_name = 'absent_days'
);
SET @sql := IF(@has_absent = 0,
  'ALTER TABLE attendance_iga_executions
     ADD COLUMN `absent_days` INT NULL AFTER `rule_key`,
     ADD COLUMN `attendance_status` VARCHAR(100) NULL AFTER `absent_days`',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
