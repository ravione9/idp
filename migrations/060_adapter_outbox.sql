-- 060_adapter_outbox.sql
-- Creates adapter_outbox for the async downstream sync worker (outbox-worker.ts,
-- utils/outbox.ts, FSM lifecycle ops). Was in src/db/schema.sql but missing from
-- numbered migrations — production DBs created via migrations only never got this table.
-- Idempotent: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS adapter_outbox (
    id              BIGINT          NOT NULL AUTO_INCREMENT,
    emp_id          VARCHAR(20)     NOT NULL,
    `system`        VARCHAR(30)     NOT NULL,
    op              ENUM(
                      'DISABLE','ENABLE','DELETE',
                      'REVOKE_TOKENS','REVOKE_BINDINGS','LIST_BINDINGS',
                      'TERMINATE_HRMS','REINSTATE_HRMS',
                      'CREATE_USER','UPDATE_USER'
                    ) NOT NULL,
    payload         JSON            DEFAULT NULL,
    priority        ENUM('HIGH','NORMAL') NOT NULL DEFAULT 'NORMAL',
    attempts        INT             NOT NULL DEFAULT 0,
    max_attempts    INT             NOT NULL DEFAULT 5,
    next_run_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status          ENUM('PENDING','PROCESSING','DONE','DEAD') NOT NULL DEFAULT 'PENDING',
    last_error      TEXT            DEFAULT NULL,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_poll (status, next_run_at),
    INDEX idx_emp_system (emp_id, `system`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
