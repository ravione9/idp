-- ============================================================
-- Migration 030 — Attendance IGA SFTP auto-fetch
-- ============================================================

ALTER TABLE attendance_iga_config
  MODIFY source_type ENUM('REST_API','FILE_UPLOAD','SFTP','BOTH') NOT NULL DEFAULT 'REST_API';

ALTER TABLE attendance_iga_import_runs
  MODIFY source ENUM('REST_API','FILE_UPLOAD','SFTP','MANUAL') NOT NULL;

ALTER TABLE attendance_iga_config
  ADD COLUMN sftp_config JSON NULL AFTER api_body_template;

ALTER TABLE attendance_iga_config
  ADD COLUMN sftp_last_file VARCHAR(512) NULL AFTER sftp_config;
