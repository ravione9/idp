-- 050 — Soften legacy notifications columns from migration 003
-- sendNotification was written for the 011 service columns, but 003 still requires
-- recipient / template / payload NOT NULL → "Field 'recipient' doesn't have a default value".

ALTER TABLE notifications
  MODIFY COLUMN recipient VARCHAR(255) NULL DEFAULT NULL,
  MODIFY COLUMN template  VARCHAR(100) NULL DEFAULT 'generic',
  MODIFY COLUMN payload   JSON NULL;

-- Ensure service columns exist (idempotent with 011)
SET @has_recip = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notifications' AND COLUMN_NAME = 'recipient_emp_id'
);
SET @sql = IF(@has_recip = 0,
  'ALTER TABLE notifications ADD COLUMN recipient_emp_id VARCHAR(20) DEFAULT NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
