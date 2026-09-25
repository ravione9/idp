-- 069: Persist MFA enrollment grace start so Redis TTL expiry cannot reset the window.
SET @needs_grace := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'employees'
    AND column_name = 'mfa_grace_started_at'
);
SET @sql := IF(@needs_grace = 0,
  'ALTER TABLE employees ADD COLUMN mfa_grace_started_at DATETIME DEFAULT NULL COMMENT ''UTC when MFA enrollment grace first started; NULL = not started'' AFTER mfa_enforced_by',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
