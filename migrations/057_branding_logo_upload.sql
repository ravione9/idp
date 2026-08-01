-- 057: Store uploaded branding logo in DB (works across API replicas; no shared FS).
-- Idempotent.

ALTER TABLE branding_settings
  ADD COLUMN IF NOT EXISTS logo_data MEDIUMBLOB NULL COMMENT 'Uploaded logo bytes (png/jpeg/webp/gif)',
  ADD COLUMN IF NOT EXISTS logo_mime VARCHAR(64) NULL COMMENT 'MIME type of logo_data';
