-- 064_saml_default_relay_state_repair.sql
-- Repair: ensure default_relay_state exists when 063 was skipped or recorded without DDL.

SET @needs_default_relay_state := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'saml_service_providers'
    AND column_name = 'default_relay_state'
);
SET @sql := IF(@needs_default_relay_state = 0,
  'ALTER TABLE saml_service_providers ADD COLUMN default_relay_state VARCHAR(512) NULL AFTER slo_url',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
