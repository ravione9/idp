-- 022: Store client machine hostname + local LAN IP on idp_sessions (captured at login).

SET @has_client_hostname = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'idp_sessions'
    AND COLUMN_NAME  = 'client_hostname'
);
SET @sql_hostname = IF(@has_client_hostname = 0,
  'ALTER TABLE idp_sessions ADD COLUMN client_hostname VARCHAR(255) DEFAULT NULL AFTER user_agent',
  'SELECT 1 -- client_hostname already exists'
);
PREPARE s FROM @sql_hostname; EXECUTE s; DEALLOCATE PREPARE s;

SET @has_client_local_ip = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'idp_sessions'
    AND COLUMN_NAME  = 'client_local_ip'
);
SET @sql_local_ip = IF(@has_client_local_ip = 0,
  'ALTER TABLE idp_sessions ADD COLUMN client_local_ip VARCHAR(45) DEFAULT NULL AFTER client_hostname',
  'SELECT 2 -- client_local_ip already exists'
);
PREPARE s FROM @sql_local_ip; EXECUTE s; DEALLOCATE PREPARE s;
