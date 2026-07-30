-- 024: Remove client_mac — MAC address is Layer 2 and cannot be captured server-side.
--      Hostname and local IP come from X-Forwarded-For chain + reverse DNS.

SET @has_client_mac = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'idp_sessions'
    AND COLUMN_NAME  = 'client_mac'
);
SET @sql = IF(@has_client_mac = 1,
  'ALTER TABLE idp_sessions DROP COLUMN client_mac',
  'SELECT 1 -- client_mac already absent'
);
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
