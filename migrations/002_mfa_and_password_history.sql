-- 002_mfa_and_password_history.sql — TOTP MFA + password change tracking

CREATE TABLE IF NOT EXISTS mfa_secrets (
    id              BIGINT          NOT NULL AUTO_INCREMENT,
    emp_id          VARCHAR(20)     NOT NULL,
    secret_b32      VARCHAR(64)     NOT NULL,
    enabled         BOOL            NOT NULL DEFAULT 0,
    enrolled_at     DATETIME        DEFAULT NULL,
    last_used_at    DATETIME        DEFAULT NULL,
    backup_codes    JSON            DEFAULT NULL,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_mfa_emp (emp_id),
    CONSTRAINT fk_mfa_emp FOREIGN KEY (emp_id) REFERENCES employees (emp_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS local_password_history (
    id              BIGINT          NOT NULL AUTO_INCREMENT,
    account_id      BIGINT          NOT NULL,
    password_hash   VARCHAR(255)    NOT NULL,
    changed_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    changed_by      VARCHAR(20)     NOT NULL,
    PRIMARY KEY (id),
    INDEX idx_lph_account (account_id, changed_at DESC),
    CONSTRAINT fk_lph_account FOREIGN KEY (account_id) REFERENCES local_accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_attempts (
    id              BIGINT          NOT NULL AUTO_INCREMENT,
    email           VARCHAR(255)    NOT NULL,
    ip              VARCHAR(45)     DEFAULT NULL,
    success         BOOL            NOT NULL,
    reason          VARCHAR(100)    DEFAULT NULL,
    ts              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_email_ts (email, ts DESC),
    INDEX idx_ip_ts (ip, ts DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
