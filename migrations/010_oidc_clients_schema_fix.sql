-- ============================================================
-- Migration 010 — Ensure oidc_clients has correct columns
-- (Idempotent: safe to re-run)
-- Fixes cases where migration 007 was not applied:
--   · Adds `name` column if missing
--   · Renames token_endpoint_auth → token_endpoint_auth_method if needed
-- ============================================================

-- 1. Add `name` column (may already exist from migration 007)
SET @has_name = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'oidc_clients'
    AND COLUMN_NAME  = 'name'
);
SET @sql1 = IF(@has_name = 0,
  'ALTER TABLE oidc_clients ADD COLUMN name VARCHAR(150) NOT NULL DEFAULT \'\' AFTER id',
  'SELECT 1 -- name already exists'
);
PREPARE s FROM @sql1; EXECUTE s; DEALLOCATE PREPARE s;

-- Backfill name for rows that are still empty
UPDATE oidc_clients SET name = client_id WHERE name = '' OR name IS NULL;

-- 2. Rename token_endpoint_auth → token_endpoint_auth_method (if old name still present)
SET @has_old_col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'oidc_clients'
    AND COLUMN_NAME  = 'token_endpoint_auth'
);
SET @sql2 = IF(@has_old_col = 1,
  'ALTER TABLE oidc_clients CHANGE COLUMN token_endpoint_auth token_endpoint_auth_method ENUM(''client_secret_basic'',''client_secret_post'',''none'',''private_key_jwt'') NOT NULL DEFAULT ''client_secret_basic''',
  'SELECT 2 -- token_endpoint_auth_method already correct'
);
PREPARE s FROM @sql2; EXECUTE s; DEALLOCATE PREPARE s;

-- 3. Add token_endpoint_auth_method if neither old nor new exists (fresh DB)
SET @has_new_col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'oidc_clients'
    AND COLUMN_NAME  = 'token_endpoint_auth_method'
);
SET @sql3 = IF(@has_new_col = 0,
  'ALTER TABLE oidc_clients ADD COLUMN token_endpoint_auth_method ENUM(''client_secret_basic'',''client_secret_post'',''none'',''private_key_jwt'') NOT NULL DEFAULT ''client_secret_basic''',
  'SELECT 3 -- column exists'
);
PREPARE s FROM @sql3; EXECUTE s; DEALLOCATE PREPARE s;
