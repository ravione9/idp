-- 066_state_transitions.sql
-- FSM transition history. Present in schema.sql bootstrap but was never shipped
-- as a migration, so migration-only prod DBs (e.g. idp) were missing the table.

CREATE TABLE IF NOT EXISTS state_transitions (
  id              BIGINT          NOT NULL AUTO_INCREMENT,
  emp_id          VARCHAR(20)     NOT NULL,
  from_state      VARCHAR(30)     NOT NULL,
  to_state        VARCHAR(30)     NOT NULL,
  reason_code     VARCHAR(50)     NOT NULL,
  evidence        JSON            DEFAULT NULL,
  actor           ENUM('SYSTEM','MANAGER','HRBP','ADMIN','SUPER_ADMIN') NOT NULL,
  actor_id        VARCHAR(20)     NOT NULL,
  origin          ENUM('HRMS_SYNC','LILG','EXTERNAL') NOT NULL,
  ts              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  workflow_run_id VARCHAR(36)     DEFAULT NULL,
  PRIMARY KEY (id),
  INDEX idx_emp_ts (emp_id, ts DESC),
  INDEX idx_actor_ts (actor_id, ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
