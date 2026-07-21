-- 034: Connector connection lifecycle — health checks, CONFIGURED until proven

ALTER TABLE connectors
  ADD COLUMN IF NOT EXISTS last_health_check_at DATETIME NULL AFTER last_error,
  ADD COLUMN IF NOT EXISTS last_health_ok TINYINT(1) NULL AFTER last_health_check_at;

-- Sources that were marked ACTIVE without ever syncing/connecting → Configured
UPDATE connectors
   SET status = 'CONFIGURED'
 WHERE status = 'ACTIVE'
   AND last_sync_at IS NULL
   AND (last_health_ok IS NULL OR last_health_ok = 0);
