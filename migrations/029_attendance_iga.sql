-- ============================================================
-- Migration 029 — Attendance-Based Identity Governance
-- Configurable attendance import, rule engine, approvals, rollback
-- ============================================================

CREATE TABLE IF NOT EXISTS attendance_iga_config (
  id                    INT             NOT NULL PRIMARY KEY DEFAULT 1,
  enabled               TINYINT(1)      NOT NULL DEFAULT 0,
  source_type           ENUM('REST_API','FILE_UPLOAD','BOTH') NOT NULL DEFAULT 'REST_API',
  api_url               VARCHAR(512),
  api_method            ENUM('GET','POST') NOT NULL DEFAULT 'GET',
  api_auth_type         ENUM('NONE','BEARER','BASIC','API_KEY') NOT NULL DEFAULT 'NONE',
  api_auth_config       JSON,
  api_headers           JSON,
  api_body_template     JSON,
  polling_interval      ENUM('5m','15m','1h','1d','manual') NOT NULL DEFAULT '1h',
  file_mapping_json     JSON,
  identifier_field      ENUM('EMPLOYEE_ID','EMPLOYEE_CODE','EMAIL','USERNAME') NOT NULL DEFAULT 'EMPLOYEE_ID',
  cutoff_time           TIME            NOT NULL DEFAULT '10:00:00',
  consecutive_days      INT             NOT NULL DEFAULT 3,
  approval_enabled      TINYINT(1)      NOT NULL DEFAULT 0,
  emergency_mode        TINYINT(1)      NOT NULL DEFAULT 0,
  notify_channels       JSON,
  notify_recipients     JSON,
  connector_actions     JSON,
  last_sync_at          DATETIME,
  last_sync_status      ENUM('OK','FAILED','PARTIAL'),
  last_sync_error       TEXT,
  updated_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by            VARCHAR(20)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO attendance_iga_config (id) VALUES (1);

CREATE TABLE IF NOT EXISTS attendance_iga_rules (
  id              VARCHAR(36)   NOT NULL PRIMARY KEY,
  rule_key        VARCHAR(50)   NOT NULL,
  name            VARCHAR(150)  NOT NULL,
  rule_type       ENUM('ACTION','IGNORE') NOT NULL,
  condition_json  JSON,
  actions_json    JSON,
  priority        INT           NOT NULL DEFAULT 100,
  active          TINYINT(1)    NOT NULL DEFAULT 1,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_att_rule_key (rule_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS attendance_iga_exclusions (
  id              VARCHAR(36)   NOT NULL PRIMARY KEY,
  exclusion_type  ENUM('VIP_USER','DEPARTMENT','EMPLOYEE') NOT NULL,
  value           VARCHAR(255)  NOT NULL,
  notes           VARCHAR(500),
  active          TINYINT(1)    NOT NULL DEFAULT 1,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_att_excl (exclusion_type, value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS attendance_iga_import_runs (
  id              VARCHAR(36)   NOT NULL PRIMARY KEY,
  source          ENUM('REST_API','FILE_UPLOAD','MANUAL') NOT NULL,
  status          ENUM('RUNNING','COMPLETED','FAILED','PARTIAL') NOT NULL DEFAULT 'RUNNING',
  total_records   INT           NOT NULL DEFAULT 0,
  successful      INT           NOT NULL DEFAULT 0,
  failed          INT           NOT NULL DEFAULT 0,
  duplicates      INT           NOT NULL DEFAULT 0,
  unmatched       INT           NOT NULL DEFAULT 0,
  users_processed INT           NOT NULL DEFAULT 0,
  users_suspended INT           NOT NULL DEFAULT 0,
  users_disabled  INT           NOT NULL DEFAULT 0,
  apps_removed    INT           NOT NULL DEFAULT 0,
  report_json     JSON,
  error_message   TEXT,
  started_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at    DATETIME,
  initiated_by    VARCHAR(20)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS attendance_iga_staging (
  id                BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
  import_run_id     VARCHAR(36)   NOT NULL,
  source_row        INT           NOT NULL DEFAULT 0,
  raw_identifier    VARCHAR(255),
  raw_email         VARCHAR(255),
  raw_username      VARCHAR(255),
  punch_date        DATE,
  punch_time        TIME,
  punch_ts          DATETIME,
  status            ENUM('PENDING','VALID','INVALID','DUPLICATE','MATCHED','UNMATCHED') NOT NULL DEFAULT 'PENDING',
  validation_errors JSON,
  matched_emp_id    VARCHAR(20),
  raw_json          JSON,
  INDEX idx_staging_run (import_run_id, status),
  CONSTRAINT fk_staging_run FOREIGN KEY (import_run_id) REFERENCES attendance_iga_import_runs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS attendance_iga_evaluations (
  id                  VARCHAR(36)   NOT NULL PRIMARY KEY,
  import_run_id       VARCHAR(36)   NOT NULL,
  emp_id              VARCHAR(20)   NOT NULL,
  rule_key            VARCHAR(50)   NOT NULL,
  rule_name           VARCHAR(150)  NOT NULL,
  attendance_status   VARCHAR(100),
  action_recommended  VARCHAR(100),
  skipped_reason      VARCHAR(255),
  evaluated_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_eval_run (import_run_id),
  INDEX idx_eval_emp (emp_id, evaluated_at DESC),
  CONSTRAINT fk_eval_run FOREIGN KEY (import_run_id) REFERENCES attendance_iga_import_runs (id) ON DELETE CASCADE,
  CONSTRAINT fk_eval_emp FOREIGN KEY (emp_id) REFERENCES employees (emp_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS attendance_iga_approvals (
  id              VARCHAR(36)   NOT NULL PRIMARY KEY,
  import_run_id   VARCHAR(36)   NOT NULL,
  evaluation_id   VARCHAR(36)   NOT NULL,
  emp_id          VARCHAR(20)   NOT NULL,
  rule_key        VARCHAR(50)   NOT NULL,
  actions_json    JSON          NOT NULL,
  status          ENUM('PENDING','APPROVED','REJECTED','SKIPPED') NOT NULL DEFAULT 'PENDING',
  approver_emp_id VARCHAR(20),
  decision_note   TEXT,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at      DATETIME,
  INDEX idx_appr_status (status, created_at DESC),
  CONSTRAINT fk_appr_run FOREIGN KEY (import_run_id) REFERENCES attendance_iga_import_runs (id) ON DELETE CASCADE,
  CONSTRAINT fk_appr_eval FOREIGN KEY (evaluation_id) REFERENCES attendance_iga_evaluations (id) ON DELETE CASCADE,
  CONSTRAINT fk_appr_emp FOREIGN KEY (emp_id) REFERENCES employees (emp_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS attendance_iga_executions (
  id              VARCHAR(36)   NOT NULL PRIMARY KEY,
  import_run_id   VARCHAR(36)   NOT NULL,
  approval_id     VARCHAR(36),
  emp_id          VARCHAR(20)   NOT NULL,
  rule_key        VARCHAR(50)   NOT NULL,
  actions_taken   JSON          NOT NULL,
  connector_used  VARCHAR(100),
  apps_removed    JSON,
  groups_removed  JSON,
  roles_removed   JSON,
  rollback_json   JSON          NOT NULL,
  status          ENUM('SUCCESS','FAILED','PARTIAL') NOT NULL,
  error_message   TEXT,
  api_response    JSON,
  executed_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  executed_by     VARCHAR(20)   NOT NULL,
  rolled_back     TINYINT(1)    NOT NULL DEFAULT 0,
  INDEX idx_exec_run (import_run_id),
  INDEX idx_exec_emp (emp_id, executed_at DESC),
  CONSTRAINT fk_exec_run FOREIGN KEY (import_run_id) REFERENCES attendance_iga_import_runs (id) ON DELETE CASCADE,
  CONSTRAINT fk_exec_emp FOREIGN KEY (emp_id) REFERENCES employees (emp_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS attendance_iga_rollback_log (
  id              VARCHAR(36)   NOT NULL PRIMARY KEY,
  execution_id    VARCHAR(36)   NOT NULL,
  rolled_back_by  VARCHAR(20)   NOT NULL,
  rollback_details JSON         NOT NULL,
  rolled_back_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_rb_exec FOREIGN KEY (execution_id) REFERENCES attendance_iga_executions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Default rules A–H
INSERT IGNORE INTO attendance_iga_rules (id, rule_key, name, rule_type, condition_json, actions_json, priority) VALUES
  ('a1111111-1111-4111-8111-111111111111', 'NO_PUNCH_TODAY', 'No Punch-In Today (after cutoff)', 'ACTION',
   '{"type":"NO_PUNCH_TODAY"}', '["SUSPEND_USER"]', 10),
  ('a2222222-2222-4222-8222-222222222222', 'NO_PUNCH_CONSECUTIVE', 'No Punch-In Consecutive Days', 'ACTION',
   '{"type":"NO_PUNCH_CONSECUTIVE"}', '["DISABLE_USER"]', 20),
  ('a3333333-3333-4333-8333-333333333333', 'TERMINATED', 'Employee Terminated', 'ACTION',
   '{"type":"TERMINATED"}', '["REMOVE_ALL_APPS","DISABLE_USER"]', 5),
  ('a4444444-4444-4444-8444-444444444444', 'APPROVED_LEAVE', 'Approved Leave', 'IGNORE',
   '{"type":"APPROVED_LEAVE"}', NULL, 1),
  ('a5555555-5555-4555-8555-555555555555', 'WEEKEND', 'Weekend', 'IGNORE',
   '{"type":"WEEKEND"}', NULL, 2),
  ('a6666666-6666-4666-8666-666666666666', 'HOLIDAY', 'Holiday', 'IGNORE',
   '{"type":"HOLIDAY"}', NULL, 3),
  ('a7777777-7777-4777-8777-777777777777', 'VIP_USER', 'VIP User', 'IGNORE',
   '{"type":"VIP_USER"}', NULL, 4),
  ('a8888888-8888-4888-8888-888888888888', 'EXCLUDED_DEPT', 'Excluded Department', 'IGNORE',
   '{"type":"EXCLUDED_DEPT"}', NULL, 5);
