-- 034_mfa_extended_methods.sql — Email OTP, SMS OTP, WebAuthn method enrollments

CREATE TABLE IF NOT EXISTS mfa_method_enrollments (
    emp_id          VARCHAR(20)     NOT NULL,
    method          VARCHAR(32)     NOT NULL,
    enabled         TINYINT(1)      NOT NULL DEFAULT 0,
    enrolled_at     DATETIME        DEFAULT NULL,
    metadata        JSON            DEFAULT NULL,
    PRIMARY KEY (emp_id, method),
    KEY idx_mfa_method_enabled (method, enabled),
    CONSTRAINT fk_mfa_method_emp FOREIGN KEY (emp_id) REFERENCES employees (emp_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO mfa_policy (policy_key, policy_value)
VALUES ('allowed_methods', '["totp","backup_codes","webauthn","email_otp","sms_otp"]')
ON DUPLICATE KEY UPDATE policy_value = VALUES(policy_value);
