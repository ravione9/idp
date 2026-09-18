-- 067: Store uploaded application icons in DB (SAML / OIDC portal tiles).
-- Idempotent. Works across API replicas (no shared filesystem).

ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS icon_data MEDIUMBLOB NULL COMMENT 'Uploaded app icon bytes (png/jpeg/webp/gif)',
  ADD COLUMN IF NOT EXISTS icon_mime VARCHAR(64) NULL COMMENT 'MIME type of icon_data';
