-- ============================================================
-- Migration 028 — Workflow run history
-- Tracks execution of workflow_definitions triggered by platform events.
-- ============================================================

CREATE TABLE IF NOT EXISTS workflow_runs (
  id              VARCHAR(36)   NOT NULL PRIMARY KEY,
  workflow_id     VARCHAR(36)   NOT NULL,
  emp_id          VARCHAR(20)   NOT NULL,
  trigger_event   VARCHAR(100)  NOT NULL,
  current_step    INT           NOT NULL DEFAULT 0,
  steps_total     INT           NOT NULL DEFAULT 0,
  status          ENUM('RUNNING','COMPLETED','FAILED','HALTED') NOT NULL DEFAULT 'RUNNING',
  context_json    JSON,
  error_message   TEXT,
  started_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at        DATETIME,
  INDEX idx_wf_runs_wf (workflow_id, status),
  INDEX idx_wf_runs_emp (emp_id, started_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
