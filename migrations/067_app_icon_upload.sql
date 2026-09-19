-- 067: Store uploaded application icons in DB (SAML / OIDC portal tiles).
-- Idempotent via information_schema (works on MySQL without ADD COLUMN IF NOT EXISTS).

SET @needs_icon_data := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'applications'
    AND column_name = 'icon_data'
);
SET @sql := IF(@needs_icon_data = 0,
  'ALTER TABLE applications ADD COLUMN icon_data MEDIUMBLOB NULL COMMENT ''Uploaded app icon bytes (png/jpeg/webp/gif)''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @needs_icon_mime := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'applications'
    AND column_name = 'icon_mime'
);
SET @sql := IF(@needs_icon_mime = 0,
  'ALTER TABLE applications ADD COLUMN icon_mime VARCHAR(64) NULL COMMENT ''MIME type of icon_data''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
