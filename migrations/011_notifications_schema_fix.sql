-- ============================================================
-- Migration 011 — Align notifications table with service layer
-- (Idempotent: safe to re-run)
--
-- The original migration 003 created a generic notifications
-- table (recipient VARCHAR, template, payload JSON).  The
-- notification.ts service was written expecting a richer schema
-- with recipient_emp_id, subject, body, template_id, etc.
-- This migration adds the missing columns, keeping old columns
-- so existing rows are not lost.
-- ============================================================

-- 1. recipient_emp_id
SET @has_recip_emp = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'notifications'
    AND COLUMN_NAME  = 'recipient_emp_id'
);
SET @sql1 = IF(@has_recip_emp = 0,
  'ALTER TABLE notifications ADD COLUMN recipient_emp_id VARCHAR(20) DEFAULT NULL',
  'SELECT 1 -- recipient_emp_id already exists'
);
PREPARE s FROM @sql1; EXECUTE s; DEALLOCATE PREPARE s;

-- 2. subject
SET @has_subject = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'notifications'
    AND COLUMN_NAME  = 'subject'
);
SET @sql2 = IF(@has_subject = 0,
  'ALTER TABLE notifications ADD COLUMN subject VARCHAR(255) DEFAULT NULL',
  'SELECT 2 -- subject already exists'
);
PREPARE s FROM @sql2; EXECUTE s; DEALLOCATE PREPARE s;

-- 3. body
SET @has_body = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'notifications'
    AND COLUMN_NAME  = 'body'
);
SET @sql3 = IF(@has_body = 0,
  'ALTER TABLE notifications ADD COLUMN body TEXT DEFAULT NULL',
  'SELECT 3 -- body already exists'
);
PREPARE s FROM @sql3; EXECUTE s; DEALLOCATE PREPARE s;

-- 4. template_id
SET @has_tmpl_id = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'notifications'
    AND COLUMN_NAME  = 'template_id'
);
SET @sql4 = IF(@has_tmpl_id = 0,
  'ALTER TABLE notifications ADD COLUMN template_id VARCHAR(100) DEFAULT NULL',
  'SELECT 4 -- template_id already exists'
);
PREPARE s FROM @sql4; EXECUTE s; DEALLOCATE PREPARE s;

-- 5. reference_id
SET @has_ref_id = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'notifications'
    AND COLUMN_NAME  = 'reference_id'
);
SET @sql5 = IF(@has_ref_id = 0,
  'ALTER TABLE notifications ADD COLUMN reference_id VARCHAR(64) DEFAULT NULL',
  'SELECT 5 -- reference_id already exists'
);
PREPARE s FROM @sql5; EXECUTE s; DEALLOCATE PREPARE s;

-- 6. reference_type
SET @has_ref_type = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'notifications'
    AND COLUMN_NAME  = 'reference_type'
);
SET @sql6 = IF(@has_ref_type = 0,
  'ALTER TABLE notifications ADD COLUMN reference_type VARCHAR(40) DEFAULT NULL',
  'SELECT 6 -- reference_type already exists'
);
PREPARE s FROM @sql6; EXECUTE s; DEALLOCATE PREPARE s;

-- 7. error (the service updates this column on failure; old schema used last_error)
SET @has_error = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'notifications'
    AND COLUMN_NAME  = 'error'
);
SET @sql7 = IF(@has_error = 0,
  'ALTER TABLE notifications ADD COLUMN error TEXT DEFAULT NULL',
  'SELECT 7 -- error already exists'
);
PREPARE s FROM @sql7; EXECUTE s; DEALLOCATE PREPARE s;

-- 8. Index on recipient_emp_id for fast per-user lookups
SET @has_idx = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'notifications'
    AND INDEX_NAME   = 'idx_notif_recipient_emp'
);
SET @sql8 = IF(@has_idx = 0,
  'ALTER TABLE notifications ADD INDEX idx_notif_recipient_emp (recipient_emp_id)',
  'SELECT 8 -- index already exists'
);
PREPARE s FROM @sql8; EXECUTE s; DEALLOCATE PREPARE s;
