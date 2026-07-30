-- ============================================================
-- Migration 007 — Fix oidc_clients schema + add workflow_definitions
-- Idempotent: safe to re-run after a partial apply (e.g. column added
-- but CREATE TABLE failed on invalid UTC_TIMESTAMP() defaults).
-- ============================================================

-- 1. Add 'name' column to oidc_clients (was missing from migration 003)
SET @needs_name := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'oidc_clients'
    AND column_name = 'name'
);
SET @sql := IF(@needs_name = 0,
  'ALTER TABLE oidc_clients ADD COLUMN name VARCHAR(150) NOT NULL DEFAULT '''' AFTER id',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Backfill name from client_id for any existing rows
UPDATE oidc_clients SET name = client_id WHERE name = '' OR name IS NULL;

-- 2. Rename token_endpoint_auth → token_endpoint_auth_method
--    (config-oidc-clients.ts uses the _method suffix; migration 003 used the short form)
SET @needs_rename := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'oidc_clients'
    AND column_name = 'token_endpoint_auth'
);
SET @sql := IF(@needs_rename = 1,
  'ALTER TABLE oidc_clients CHANGE COLUMN token_endpoint_auth token_endpoint_auth_method ENUM(''client_secret_basic'',''client_secret_post'',''none'',''private_key_jwt'') NOT NULL DEFAULT ''client_secret_basic''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. Create workflow_definitions table (queried by config-workflows.ts but never created)
--    Use CURRENT_TIMESTAMP — bare UTC_TIMESTAMP() is invalid in DEFAULT clauses on MySQL 8.
CREATE TABLE IF NOT EXISTS workflow_definitions (
  id            VARCHAR(36)   NOT NULL PRIMARY KEY,
  name          VARCHAR(150)  NOT NULL,
  description   TEXT,
  trigger_event VARCHAR(100),
  steps_json    JSON,
  active        TINYINT(1)    NOT NULL DEFAULT 1,
  created_by    VARCHAR(36),
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
