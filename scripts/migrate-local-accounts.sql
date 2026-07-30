-- Run on existing DB if local_accounts table is missing:
-- docker exec -i idp-mysql mysql -ulilg_app -ps3cr3t_change_me lilg < scripts/migrate-local-accounts.sql

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
