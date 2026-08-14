-- 063_saml_default_relay_state.sql
-- Optional default RelayState (post-login redirect / deep link) for IdP-initiated SAML launch.

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
