-- =============================================================================
-- 045 — Entitlement harvest (OIG-style catalog sync from connectors)
-- =============================================================================

-- Allow entitlement-harvest runs in connector history
SET @col := (
  SELECT COLUMN_TYPE FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'connector_runs'
     AND COLUMN_NAME = 'run_type'
   LIMIT 1
);
SET @sql := IF(
  @col IS NOT NULL AND @col NOT LIKE '%ENTITLEMENT_HARVEST%',
  'ALTER TABLE connector_runs MODIFY COLUMN run_type ENUM(''FULL_SYNC'',''INCREMENTAL'',''RECONCILE'',''PROVISION'',''DEPROVISION'',''ENTITLEMENT_HARVEST'') NOT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Track last harvest on entitlements
SET @col2 := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'entitlements'
     AND COLUMN_NAME = 'last_harvested_at'
);
SET @sql2 := IF(
  @col2 = 0,
  'ALTER TABLE entitlements ADD COLUMN last_harvested_at DATETIME DEFAULT NULL AFTER created_at',
  'SELECT 1'
);
PREPARE stmt2 FROM @sql2; EXECUTE stmt2; DEALLOCATE PREPARE stmt2;

-- Provision audit for target-system entitlement fulfilment
CREATE TABLE IF NOT EXISTS entitlement_provision_log (
  id              BIGINT          NOT NULL AUTO_INCREMENT,
  entitlement_id  VARCHAR(36)     NOT NULL,
  emp_id          VARCHAR(20)     NOT NULL,
  connector_id    VARCHAR(36)     DEFAULT NULL,
  action          ENUM('GRANT','REVOKE') NOT NULL,
  status          ENUM('SUCCESS','FAILED','SKIPPED') NOT NULL,
  detail          VARCHAR(500)    DEFAULT NULL,
  actor_emp_id    VARCHAR(20)     DEFAULT NULL,
  created_at      DATETIME        NOT NULL DEFAULT (UTC_TIMESTAMP()),
  PRIMARY KEY (id),
  KEY idx_epl_ent (entitlement_id),
  KEY idx_epl_emp (emp_id),
  KEY idx_epl_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
