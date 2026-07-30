-- 023: MAC address of the client endpoint (from local agent or LOC-{MAC} hostname).

SET @has_client_mac = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'idp_sessions'
    AND COLUMN_NAME  = 'client_mac'
);
SET @sql_mac = IF(@has_client_mac = 0,
  'ALTER TABLE idp_sessions ADD COLUMN client_mac VARCHAR(17) DEFAULT NULL AFTER client_local_ip',
  'SELECT 1 -- client_mac already exists'
);
PREPARE s FROM @sql_mac; EXECUTE s; DEALLOCATE PREPARE s;
