-- =============================================================================
-- LILG — Lenskart Identity Lifecycle & Governance
-- MySQL 8 Schema
-- =============================================================================

SET NAMES utf8mb4;
SET time_zone = '+05:30';

-- ---------------------------------------------------------------------------
-- employees
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employees (
    emp_id              VARCHAR(20)     NOT NULL,
    full_name           VARCHAR(255)    NOT NULL,
    email_corp          VARCHAR(255)    NOT NULL,
    email_personal      VARCHAR(255)    DEFAULT NULL,
    dept_id             VARCHAR(50)     DEFAULT NULL,
    role                VARCHAR(100)    DEFAULT NULL,
    city                VARCHAR(100)    DEFAULT NULL,
    state               VARCHAR(100)    DEFAULT NULL,
    country             VARCHAR(100)    DEFAULT 'IN',
    manager_emp_id      VARCHAR(20)     DEFAULT NULL,
    hire_date           DATE            NOT NULL,
    planned_exit_date   DATE            DEFAULT NULL,
    actual_exit_date    DATE            DEFAULT NULL,
    employment_type     ENUM('CORPORATE','STORE','PLANT','DC') NOT NULL DEFAULT 'CORPORATE',
    hrms_status         ENUM('ACTIVE','ON_NOTICE','DEPARTED') NOT NULL DEFAULT 'ACTIVE',
    ilg_state           ENUM(
                          'ACTIVE',
                          'SUSPENDED_AUTO',
                          'PENDING_MGR',
                          'ESCALATED_HRBP',
                          'REACTIVATED',
                          'SUSPENDED_HR',
                          'DEPARTED',
                          'DEPROVISIONED'
                        ) NOT NULL DEFAULT 'ACTIVE',
    ilg_state_since     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version             BIGINT          NOT NULL DEFAULT 0,
    created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (emp_id),
    UNIQUE KEY uk_email_corp (email_corp),
    KEY idx_hrms_status (hrms_status),
    KEY idx_ilg_state (ilg_state),
    KEY idx_manager (manager_emp_id),
    CONSTRAINT fk_emp_manager FOREIGN KEY (manager_emp_id) REFERENCES employees (emp_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- identity_links
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS identity_links (
    id              BIGINT          NOT NULL AUTO_INCREMENT,
    emp_id          VARCHAR(20)     NOT NULL,
    `system`        ENUM('GOOGLE','ZOHO','SLACK','GITHUB','AD','HRMS','NEXSID','SALESMAN_OTP','BIGQUERY','AWS_IDC') NOT NULL,
    external_id     VARCHAR(255)    NOT NULL,
    status          ENUM('ACTIVE','DISABLED','DELETED','ORPHAN') NOT NULL DEFAULT 'ACTIVE',
    last_synced_at  DATETIME        DEFAULT NULL,
    drift_flag      BOOL            NOT NULL DEFAULT 0,
    auth_kind       ENUM('OIDC','SAML','LDAP','OTP','BIOMETRIC') NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_system_external (`system`, external_id),
    KEY idx_emp_system (emp_id, `system`),
    CONSTRAINT fk_il_emp FOREIGN KEY (emp_id) REFERENCES employees (emp_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- attendance_events
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance_events (
    id          BIGINT          NOT NULL AUTO_INCREMENT,
    emp_id      VARCHAR(20)     NOT NULL,
    event_ts    DATETIME        NOT NULL,
    source      VARCHAR(50)     NOT NULL,
    location    VARCHAR(100)    DEFAULT NULL,
    device_id   VARCHAR(100)    DEFAULT NULL,
    score       FLOAT           DEFAULT NULL,
    PRIMARY KEY (id),
    INDEX idx_emp_ts (emp_id, event_ts DESC),
    CONSTRAINT fk_ae_emp FOREIGN KEY (emp_id) REFERENCES employees (emp_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- leave_records
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leave_records (
    id          BIGINT          NOT NULL AUTO_INCREMENT,
    emp_id      VARCHAR(20)     NOT NULL,
    leave_type  VARCHAR(50)     NOT NULL,
    start_date  DATE            NOT NULL,
    end_date    DATE            NOT NULL,
    status      ENUM('APPROVED','PENDING','REJECTED') NOT NULL DEFAULT 'PENDING',
    hrms_id     VARCHAR(50)     DEFAULT NULL,
    PRIMARY KEY (id),
    INDEX idx_emp_dates (emp_id, start_date, end_date),
    CONSTRAINT fk_lr_emp FOREIGN KEY (emp_id) REFERENCES employees (emp_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- holiday_calendar
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS holiday_calendar (
    id      INT             NOT NULL AUTO_INCREMENT,
    state   VARCHAR(50)     NOT NULL,
    format  ENUM('CORPORATE','STORE','PLANT','DC','ALL') NOT NULL DEFAULT 'ALL',
    date    DATE            NOT NULL,
    label   VARCHAR(100)    NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_state_format_date (state, format, date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- working_day_overrides
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS working_day_overrides (
    id                  BIGINT          NOT NULL AUTO_INCREMENT,
    emp_id              VARCHAR(20)     NOT NULL,
    date                DATE            NOT NULL,
    expected_to_work    BOOL            NOT NULL,
    reason              VARCHAR(255)    DEFAULT NULL,
    created_by          VARCHAR(20)     NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_emp_date (emp_id, date),
    CONSTRAINT fk_wdo_emp FOREIGN KEY (emp_id) REFERENCES employees (emp_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- activity_aggregate
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_aggregate (
    emp_id              VARCHAR(20)     NOT NULL,
    date                DATE            NOT NULL,
    expected_to_work    BOOL            NOT NULL DEFAULT 0,
    has_attendance      BOOL            NOT NULL DEFAULT 0,
    has_leave           BOOL            NOT NULL DEFAULT 0,
    source              VARCHAR(100)    DEFAULT NULL,
    PRIMARY KEY (emp_id, date),
    INDEX idx_emp_date_desc (emp_id, date DESC),
    CONSTRAINT fk_aa_emp FOREIGN KEY (emp_id) REFERENCES employees (emp_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- state_transitions
-- ---------------------------------------------------------------------------
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
    INDEX idx_actor_ts (actor_id, ts),
    CONSTRAINT fk_st_emp FOREIGN KEY (emp_id) REFERENCES employees (emp_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- adapter_outbox
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- audit_log (tamper-evident hash chain)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
    id          BIGINT          NOT NULL AUTO_INCREMENT,
    ts          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actor       VARCHAR(100)    NOT NULL,
    action      VARCHAR(100)    NOT NULL,
    target      VARCHAR(100)    NOT NULL,
    payload     JSON            DEFAULT NULL,
    prev_hash   CHAR(64)        DEFAULT NULL,
    curr_hash   CHAR(64)        NOT NULL,
    PRIMARY KEY (id),
    INDEX idx_target_ts (target, ts DESC),
    INDEX idx_actor_ts (actor, ts DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- lilg_sessions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lilg_sessions (
    session_id      CHAR(36)        NOT NULL,
    emp_id          VARCHAR(20)     NOT NULL,
    iss             VARCHAR(50)     NOT NULL,
    sub             VARCHAR(255)    NOT NULL,
    email           VARCHAR(255)    NOT NULL,
    role            VARCHAR(30)     NOT NULL,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_active_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at      DATETIME        NOT NULL,
    ip              VARCHAR(45)     DEFAULT NULL,
    user_agent      TEXT            DEFAULT NULL,
    revoked_at      DATETIME        DEFAULT NULL,
    PRIMARY KEY (session_id),
    INDEX idx_emp_id (emp_id),
    INDEX idx_expires (expires_at),
    CONSTRAINT fk_sess_emp FOREIGN KEY (emp_id) REFERENCES employees (emp_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- abac_policies
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS abac_policies (
    id              INT             NOT NULL AUTO_INCREMENT,
    name            VARCHAR(100)    NOT NULL,
    effect          ENUM('ALLOW','DENY') NOT NULL,
    condition_expr  TEXT            NOT NULL,
    priority        INT             NOT NULL DEFAULT 100,
    active          BOOL            NOT NULL DEFAULT 1,
    created_by      VARCHAR(20)     NOT NULL,
    version         INT             NOT NULL DEFAULT 1,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_priority_active (priority, active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- role_bindings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS role_bindings (
    id              BIGINT          NOT NULL AUTO_INCREMENT,
    emp_id          VARCHAR(20)     NOT NULL,
    `system`        VARCHAR(30)     NOT NULL,
    scope           VARCHAR(255)    NOT NULL,
    role_name       VARCHAR(100)    NOT NULL,
    granted_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at      DATETIME        DEFAULT NULL,
    snapshot_ts     DATETIME        DEFAULT NULL,
    PRIMARY KEY (id),
    INDEX idx_emp_system (emp_id, `system`),
    CONSTRAINT fk_rb_emp FOREIGN KEY (emp_id) REFERENCES employees (emp_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- workflow_definitions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workflow_definitions (
    id          VARCHAR(36)     NOT NULL,
    name        VARCHAR(100)    NOT NULL,
    version     INT             NOT NULL DEFAULT 1,
    json_dag    JSON            NOT NULL,
    created_by  VARCHAR(20)     NOT NULL,
    created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    active      BOOL            NOT NULL DEFAULT 0,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- workflow_runs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workflow_runs (
    id              VARCHAR(36)     NOT NULL,
    workflow_id     VARCHAR(36)     NOT NULL,
    emp_id          VARCHAR(20)     NOT NULL,
    current_node    VARCHAR(50)     DEFAULT NULL,
    status          ENUM('RUNNING','COMPLETED','FAILED','HALTED') NOT NULL DEFAULT 'RUNNING',
    started_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ended_at        DATETIME        DEFAULT NULL,
    PRIMARY KEY (id),
    INDEX idx_emp_status (emp_id, status),
    CONSTRAINT fk_wr_wf FOREIGN KEY (workflow_id) REFERENCES workflow_definitions (id),
    CONSTRAINT fk_wr_emp FOREIGN KEY (emp_id) REFERENCES employees (emp_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- saml_service_providers — registered SAML apps (SPs) for org-wide SSO
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saml_service_providers (
    id                  VARCHAR(36)     NOT NULL,
    name                VARCHAR(100)    NOT NULL,
    slug                VARCHAR(50)     NOT NULL,
    entity_id           VARCHAR(512)    NOT NULL,
    acs_url             VARCHAR(512)    NOT NULL,
    slo_url             VARCHAR(512)    DEFAULT NULL,
    nameid_format       VARCHAR(120)    NOT NULL DEFAULT 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    attribute_map       JSON            DEFAULT NULL,
    entitlement_rule    JSON            NOT NULL,
    icon_url            VARCHAR(512)    DEFAULT NULL,
    sort_order          INT             NOT NULL DEFAULT 0,
    active              BOOL            NOT NULL DEFAULT 1,
    created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_saml_slug (slug),
    UNIQUE KEY uk_saml_entity (entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- saml_assertion_log — audit trail for issued assertions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saml_assertion_log (
    id              BIGINT          NOT NULL AUTO_INCREMENT,
    sp_id           VARCHAR(36)     NOT NULL,
    emp_id          VARCHAR(20)     NOT NULL,
    binding         ENUM('REDIRECT','POST','IDP_INITIATED') NOT NULL,
    relay_state     TEXT            DEFAULT NULL,
    request_id      VARCHAR(100)    DEFAULT NULL,
    ts              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_emp_ts (emp_id, ts DESC),
    INDEX idx_sp_ts (sp_id, ts DESC),
    CONSTRAINT fk_sal_sp FOREIGN KEY (sp_id) REFERENCES saml_service_providers (id) ON DELETE CASCADE,
    CONSTRAINT fk_sal_emp FOREIGN KEY (emp_id) REFERENCES employees (emp_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- local_accounts — email/password login for IdP administrators
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS local_accounts (
    id              BIGINT          NOT NULL AUTO_INCREMENT,
    emp_id          VARCHAR(20)     NOT NULL,
    email           VARCHAR(255)    NOT NULL,
    password_hash   VARCHAR(255)    NOT NULL,
    role            ENUM('ADMIN','SUPER_ADMIN') NOT NULL DEFAULT 'ADMIN',
    active          BOOL            NOT NULL DEFAULT 1,
    created_by      VARCHAR(20)     NOT NULL,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at   DATETIME        DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_local_email (email),
    KEY idx_local_emp (emp_id),
    CONSTRAINT fk_la_emp FOREIGN KEY (emp_id) REFERENCES employees (emp_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
