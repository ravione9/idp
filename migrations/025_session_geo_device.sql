-- 025: Replace agent-dependent columns with server-side device & geo attribution.
--      device_info  = parsed from User-Agent at login time (always available)
--      geo_location = "City · Country" from async IP geolocation (no agent needed)
--      Drop client_hostname and client_local_ip (required local agent, rarely populated).

-- Add device_info
SET @has_device_info = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'idp_sessions' AND COLUMN_NAME = 'device_info'
);
SET @s = IF(@has_device_info = 0,
  'ALTER TABLE idp_sessions ADD COLUMN device_info VARCHAR(200) DEFAULT NULL AFTER user_agent',
  'SELECT 1'
);
PREPARE s FROM @s; EXECUTE s; DEALLOCATE PREPARE s;

-- Add geo_location
SET @has_geo = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'idp_sessions' AND COLUMN_NAME = 'geo_location'
);
SET @s = IF(@has_geo = 0,
  'ALTER TABLE idp_sessions ADD COLUMN geo_location VARCHAR(200) DEFAULT NULL AFTER device_info',
  'SELECT 1'
);
PREPARE s FROM @s; EXECUTE s; DEALLOCATE PREPARE s;

-- Drop client_hostname (agent-only, never reliably populated)
SET @has_hostname = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'idp_sessions' AND COLUMN_NAME = 'client_hostname'
);
SET @s = IF(@has_hostname = 1,
  'ALTER TABLE idp_sessions DROP COLUMN client_hostname',
  'SELECT 1'
);
PREPARE s FROM @s; EXECUTE s; DEALLOCATE PREPARE s;

-- Drop client_local_ip (agent-only, never reliably populated)
SET @has_localip = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'idp_sessions' AND COLUMN_NAME = 'client_local_ip'
);
SET @s = IF(@has_localip = 1,
  'ALTER TABLE idp_sessions DROP COLUMN client_local_ip',
  'SELECT 1'
);
PREPARE s FROM @s; EXECUTE s; DEALLOCATE PREPARE s;
