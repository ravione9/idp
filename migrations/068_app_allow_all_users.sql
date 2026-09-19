-- 068: Allow all active users to launch an application (Access Policy).
-- Idempotent via information_schema.

SET @needs_allow_all := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'applications'
    AND column_name = 'allow_all_users'
);
SET @sql := IF(@needs_allow_all = 0,
  'ALTER TABLE applications ADD COLUMN allow_all_users TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''1 = any ACTIVE/REACTIVATED user may launch (Access Policy)'' AFTER visibility',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Extend audit action ENUM (idempotent: re-running with same ENUM is fine on MySQL).
ALTER TABLE app_access_audit_log
  MODIFY COLUMN action ENUM(
    'ASSIGN_USER','ASSIGN_GROUP','REVOKE','REQUEST','APPROVE','REJECT','PROVISION','ALLOW_ALL'
  ) NOT NULL;
