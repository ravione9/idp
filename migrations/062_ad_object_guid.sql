-- 062_ad_object_guid.sql
-- Store AD objectGUID on employees for SAML SPs (e.g. Autodesk) that require objectGUID.

SET @needs_ad_object_guid := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'employees'
    AND column_name = 'ad_object_guid'
);
SET @sql := IF(@needs_ad_object_guid = 0,
  'ALTER TABLE employees ADD COLUMN ad_object_guid VARCHAR(36) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @needs_idx_ad_object_guid := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'employees'
    AND index_name = 'idx_employees_ad_object_guid'
);
SET @sql := IF(@needs_idx_ad_object_guid = 0,
  'CREATE INDEX idx_employees_ad_object_guid ON employees (ad_object_guid)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
