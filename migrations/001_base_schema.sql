-- 001_base_schema.sql — bootstrap of all original LILG tables
-- This is the same DDL as src/db/schema.sql, retained here for migration tracking.
-- Idempotent: every table uses CREATE TABLE IF NOT EXISTS.

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
    ilg_state           ENUM('ACTIVE','SUSPENDED_AUTO','PENDING_MGR','ESCALATED_HRBP','REACTIVATED','SUSPENDED_HR','DEPARTED','DEPROVISIONED') NOT NULL DEFAULT 'ACTIVE',
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
