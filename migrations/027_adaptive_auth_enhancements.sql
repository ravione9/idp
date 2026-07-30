-- 027_adaptive_auth_enhancements.sql
-- Extends adaptive_auth_policies with STEP_UP action and seeds the seven
-- default policies that implement the authentication logic matrix:
--
--   Trusted Access (Corporate + Managed)           → ALLOW
--   External + Managed Device                      → MFA
--   External + Unmanaged Device                    → STEP_UP
--   High-Risk Country                              → BLOCK
--   TOR / Proxy IP                                 → BLOCK
--   Impossible Travel (country change in < 4 h)   → MFA
--   New Device                                     → MFA
--   Privileged User (ADMIN / SUPER_ADMIN)          → MFA (hard-coded in engine too)
--   High Risk Score (>= 60)                        → STEP_UP
--   Sensitive App + External Access                → MFA (catch-all for Finance/HR/ERP/CRM/PAM/Admin)
--   Default External Fallback                      → MFA
--
-- All INSERTs use INSERT IGNORE so re-applying this file is safe.

-- ── 1. Add STEP_UP to the action enum ───────────────────────────────────────

SET @col_type = (
  SELECT COLUMN_TYPE
    FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'adaptive_auth_policies'
     AND COLUMN_NAME  = 'action'
);

-- Only ALTER if STEP_UP is not already present
SET @has_stepup = (
  SELECT IF(LOCATE('STEP_UP', @col_type) > 0, 1, 0)
);

SET @alter_sql = IF(
  @has_stepup = 0,
  "ALTER TABLE adaptive_auth_policies MODIFY COLUMN action ENUM('ALLOW','MFA','STEP_UP','DENY','BLOCK') NOT NULL DEFAULT 'MFA'",
  'SELECT 1'
);
PREPARE _s FROM @alter_sql; EXECUTE _s; DEALLOCATE PREPARE _s;

-- ── 2. Seed default adaptive auth policies ───────────────────────────────────
--
-- Policy priority (lower = evaluated first).  BLOCK/STEP_UP rules go first
-- so they can't be overridden by lower-priority ALLOW rules.

-- P-10: Privileged users — always MFA
INSERT IGNORE INTO adaptive_auth_policies
  (id, name, description, priority, conditions_json, action, scope, active)
VALUES (
  UUID(),
  'Privileged Users — Always MFA',
  'Administrators and security teams must authenticate with MFA regardless of location or device.',
  10,
  JSON_ARRAY(
    JSON_OBJECT('type', 'USER_ROLE', 'values', JSON_ARRAY('ADMIN', 'SUPER_ADMIN', 'IT_OPS', 'SECURITY'))
  ),
  'MFA',
  'ALL',
  1
);

-- P-20: High-risk country — block
INSERT IGNORE INTO adaptive_auth_policies
  (id, name, description, priority, conditions_json, action, scope, active)
VALUES (
  UUID(),
  'High-Risk Country — Block',
  'Block logins originating from high-risk or sanctioned countries/regions.',
  20,
  JSON_ARRAY(
    JSON_OBJECT('type', 'COUNTRY', 'op', 'in',
      'values', JSON_ARRAY('CN','RU','KP','IR','BY','CU','SD','SY','VE','LY','MM','AF'))
  ),
  'BLOCK',
  'ALL',
  1
);

-- P-25: TOR / proxy — block
INSERT IGNORE INTO adaptive_auth_policies
  (id, name, description, priority, conditions_json, action, scope, active)
VALUES (
  UUID(),
  'TOR / Proxy — Block',
  'Block logins from TOR exit nodes, anonymous proxies, or hosting infrastructure.',
  25,
  JSON_ARRAY(
    JSON_OBJECT('type', 'TOR_PROXY')
  ),
  'BLOCK',
  'ALL',
  1
);

-- P-30: Impossible travel — MFA
INSERT IGNORE INTO adaptive_auth_policies
  (id, name, description, priority, conditions_json, action, scope, active)
VALUES (
  UUID(),
  'Impossible Travel — MFA',
  'Require MFA when a login originates from a different country less than 4 hours after the previous active session.',
  30,
  JSON_ARRAY(
    JSON_OBJECT('type', 'IMPOSSIBLE_TRAVEL')
  ),
  'MFA',
  'ALL',
  1
);

-- P-40: New / unrecognised device — MFA
INSERT IGNORE INTO adaptive_auth_policies
  (id, name, description, priority, conditions_json, action, scope, active)
VALUES (
  UUID(),
  'New Device — MFA',
  'Require MFA when a user logs in from a device not seen in their previous sessions.',
  40,
  JSON_ARRAY(
    JSON_OBJECT('type', 'NEW_DEVICE')
  ),
  'MFA',
  'ALL',
  1
);

-- P-50: High risk score — step-up (MFA + manager-approval flag)
INSERT IGNORE INTO adaptive_auth_policies
  (id, name, description, priority, conditions_json, action, scope, active)
VALUES (
  UUID(),
  'High Risk Score — Step-Up Approval',
  'Require MFA and manager approval when the computed login risk score exceeds 60.',
  50,
  JSON_ARRAY(
    JSON_OBJECT('type', 'RISK_SCORE', 'op', 'gte', 'value', 60)
  ),
  'STEP_UP',
  'ALL',
  1
);

-- P-60: External + unmanaged device — step-up
INSERT IGNORE INTO adaptive_auth_policies
  (id, name, description, priority, conditions_json, action, scope, active)
VALUES (
  UUID(),
  'External Network + Unmanaged Device — Step-Up',
  'Require MFA and device verification for logins from external networks on unmanaged devices.',
  60,
  JSON_ARRAY(
    JSON_OBJECT('type', 'NETWORK_TYPE', 'values', JSON_ARRAY('EXTERNAL')),
    JSON_OBJECT('type', 'DEVICE_MANAGED', 'value', 'false')
  ),
  'STEP_UP',
  'ALL',
  1
);

-- P-70: External + managed device — MFA
INSERT IGNORE INTO adaptive_auth_policies
  (id, name, description, priority, conditions_json, action, scope, active)
VALUES (
  UUID(),
  'External Network + Managed Device — MFA',
  'Require MFA for logins from external networks even when the device is managed.',
  70,
  JSON_ARRAY(
    JSON_OBJECT('type', 'NETWORK_TYPE', 'values', JSON_ARRAY('EXTERNAL')),
    JSON_OBJECT('type', 'DEVICE_MANAGED', 'value', 'true')
  ),
  'MFA',
  'ALL',
  1
);

-- P-80: Sensitive application + external access — MFA
INSERT IGNORE INTO adaptive_auth_policies
  (id, name, description, priority, conditions_json, action, scope, active)
VALUES (
  UUID(),
  'Sensitive Application + External Access — MFA',
  'Finance, HR, ERP, CRM, PAM, and administrative portals require MFA for all external access.',
  80,
  JSON_ARRAY(
    JSON_OBJECT('type', 'SENSITIVE_APP'),
    JSON_OBJECT('type', 'NETWORK_TYPE', 'values', JSON_ARRAY('EXTERNAL'))
  ),
  'MFA',
  'ALL',
  1
);

-- P-100: Trusted access — corporate network + managed device → allow
INSERT IGNORE INTO adaptive_auth_policies
  (id, name, description, priority, conditions_json, action, scope, active)
VALUES (
  UUID(),
  'Trusted Access — Corporate Network + Managed Device',
  'Allow primary-authentication-only access from the corporate network on a managed device with a low risk profile.',
  100,
  JSON_ARRAY(
    JSON_OBJECT('type', 'NETWORK_TYPE', 'values', JSON_ARRAY('CORPORATE')),
    JSON_OBJECT('type', 'DEVICE_MANAGED', 'value', 'true'),
    JSON_OBJECT('type', 'RISK_SCORE', 'op', 'lt', 'value', 30)
  ),
  'ALLOW',
  'ALL',
  1
);

-- P-999: Default external fallback — MFA for any unmatched external login
INSERT IGNORE INTO adaptive_auth_policies
  (id, name, description, priority, conditions_json, action, scope, active)
VALUES (
  UUID(),
  'Default External Access — MFA',
  'Catch-all: any external login not matched by a more specific policy requires MFA.',
  999,
  JSON_ARRAY(
    JSON_OBJECT('type', 'NETWORK_TYPE', 'values', JSON_ARRAY('EXTERNAL'))
  ),
  'MFA',
  'ALL',
  1
);
