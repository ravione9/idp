-- 070: Admin option — do not auto-suspend portal users when another directory
-- (AD / Google) still has an ACTIVE identity link.
SET @needs_col := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'general_settings'
    AND column_name = 'skip_suspend_if_active_elsewhere'
);
SET @sql := IF(@needs_col = 0,
  'ALTER TABLE general_settings ADD COLUMN skip_suspend_if_active_elsewhere TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''1 = skip DIRECTORY_DISABLED portal suspend when another AD/Google link is ACTIVE'' AFTER allow_local_login',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
