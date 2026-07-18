-- ============================================================
-- Migration 031 — Attendance IGA API provider (Truein / generic)
-- ============================================================

ALTER TABLE attendance_iga_config
  ADD COLUMN api_provider ENUM('GENERIC','TRUIN') NOT NULL DEFAULT 'GENERIC' AFTER source_type;

ALTER TABLE attendance_iga_config
  ADD COLUMN api_config JSON NULL AFTER api_body_template;
