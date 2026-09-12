-- 065_app_provision_log_heal.sql
-- Ensure app_provision_log exists (heal envs that skipped 064) and backfill
-- historical SAML assertion deliveries so Audit → App provisioning log is populated.

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

-- Backfill from SSO assertion log (idempotent via request_id / emp+ts+acs).
INSERT INTO app_provision_log
  (app_id, emp_id, action, source, http_method, endpoint, status, status_code,
   detail, request_body, response_body, request_id, created_at)
SELECT
  a.id,
  sal.emp_id,
  'PROVISION',
  'SAML_ASSERTION',
  CASE WHEN sal.binding = 'REDIRECT' THEN 'GET' ELSE 'POST' END,
  sp.acs_url,
  'SUCCESS',
  200,
  CONCAT('SAML ', sal.binding, ' assertion to ', sp.name, ' ACS'),
  JSON_OBJECT(
    'protocol', 'SAML',
    'binding', sal.binding,
    'entityId', sp.entity_id,
    'launchPath', CONCAT('/saml/launch/', sp.slug),
    'relayState', sal.relay_state,
    'requestId', sal.request_id,
    'backfill', TRUE
  ),
  JSON_OBJECT('protocol', 'SAML', 'spSlug', sp.slug, 'sloUrl', sp.slo_url),
  sal.request_id,
  sal.ts
FROM saml_assertion_log sal
INNER JOIN saml_service_providers sp ON sp.id = sal.sp_id
LEFT JOIN applications a ON a.slug = sp.slug
WHERE sp.acs_url IS NOT NULL
  AND sp.acs_url <> ''
  AND NOT EXISTS (
    SELECT 1 FROM app_provision_log l
     WHERE l.source = 'SAML_ASSERTION'
       AND l.emp_id = sal.emp_id
       AND (
         (sal.request_id IS NOT NULL AND sal.request_id <> '' AND l.request_id = sal.request_id)
         OR (
           (sal.request_id IS NULL OR sal.request_id = '')
           AND l.endpoint = sp.acs_url
           AND l.created_at = sal.ts
         )
       )
  );
