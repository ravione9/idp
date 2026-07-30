-- =============================================================================
-- 046 — Entitlements: requestable flag (directory harvest ≠≠ Request Access)
-- =============================================================================
-- Harvested AD/Google groups stay in the admin catalog for governance but must
-- not flood end-user Request Access. Only curated / app entitlements are requestable.

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'entitlements'
     AND COLUMN_NAME = 'requestable'
);
SET @sql := IF(
  @col = 0,
  'ALTER TABLE entitlements ADD COLUMN requestable TINYINT(1) NOT NULL DEFAULT 1 AFTER active',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Directory-harvested groups (have connector + external_id) are not requestable
UPDATE entitlements
   SET requestable = 0
 WHERE connector_id IS NOT NULL
   AND external_id IS NOT NULL
   AND external_id != '';
