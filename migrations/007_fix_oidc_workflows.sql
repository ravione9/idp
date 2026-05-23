-- ============================================================
-- Migration 007 — Fix oidc_clients schema + add workflow_definitions
-- ============================================================

-- 1. Add 'name' column to oidc_clients (was missing from migration 003)
ALTER TABLE oidc_clients
  ADD COLUMN name VARCHAR(150) NOT NULL DEFAULT '' AFTER id;

-- Backfill name from client_id for any existing rows
UPDATE oidc_clients SET name = client_id WHERE name = '' OR name IS NULL;

-- 2. Rename token_endpoint_auth → token_endpoint_auth_method
--    (config-oidc-clients.ts uses the _method suffix; migration 003 used the short form)
ALTER TABLE oidc_clients
  CHANGE COLUMN token_endpoint_auth
    token_endpoint_auth_method ENUM('client_secret_basic','client_secret_post','none','private_key_jwt')
    NOT NULL DEFAULT 'client_secret_basic';

-- 3. Create workflow_definitions table (queried by config-workflows.ts but never created)
CREATE TABLE IF NOT EXISTS workflow_definitions (
  id            VARCHAR(36)   NOT NULL PRIMARY KEY,
  name          VARCHAR(150)  NOT NULL,
  description   TEXT,
  trigger_event VARCHAR(100),
  steps_json    JSON,
  active        TINYINT(1)    NOT NULL DEFAULT 1,
  created_by    VARCHAR(36),
  created_at    DATETIME      NOT NULL DEFAULT UTC_TIMESTAMP(),
  updated_at    DATETIME      NOT NULL DEFAULT UTC_TIMESTAMP()
    ON UPDATE UTC_TIMESTAMP()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
