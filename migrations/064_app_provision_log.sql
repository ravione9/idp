-- 064_app_provision_log.sql
-- Application-level user provisioning / deprovisioning audit (SCIM + IdP grant/revoke).

CREATE TABLE IF NOT EXISTS app_provision_log (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  app_id          VARCHAR(36)     DEFAULT NULL,
  emp_id          VARCHAR(20)     NOT NULL,
  action          ENUM('PROVISION','DEPROVISION') NOT NULL,
  source          VARCHAR(32)     DEFAULT NULL,
  http_method     VARCHAR(10)     DEFAULT NULL,
  endpoint        VARCHAR(1024)   DEFAULT NULL,
  status          ENUM('SUCCESS','FAILED','SKIPPED') NOT NULL,
  status_code     INT             DEFAULT NULL,
  detail          VARCHAR(500)    DEFAULT NULL,
  request_body    JSON            DEFAULT NULL,
  response_body   JSON            DEFAULT NULL,
  actor_emp_id    VARCHAR(20)     DEFAULT NULL,
  request_id      VARCHAR(36)     DEFAULT NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_apl_app (app_id, created_at DESC),
  KEY idx_apl_emp (emp_id, created_at DESC),
  KEY idx_apl_action (action, created_at DESC),
  KEY idx_apl_created (created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
