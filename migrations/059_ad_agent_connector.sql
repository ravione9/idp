-- AD Agent connector — on-prem Windows service talks to IdP over HTTPS :443;
-- LDAP credentials stay on the agent host only.

-- Widen connector_type enum (idempotent).
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'connectors'
     AND COLUMN_NAME = 'connector_type'
);
SET @sql = IF(@col_exists > 0,
  'ALTER TABLE connectors MODIFY COLUMN connector_type ENUM(
    ''SCIM'',''REST'',''LDAP'',''GOOGLE_WORKSPACE'',''GOOGLE'',''ZOHO'',''SLACK'',''GITHUB'',
    ''AD'',''AD_AGENT'',''HRMS'',''AWS_IAM'',''AZURE_AD'',''OKTA'',''SALESFORCE'',''JDBC'',''CUSTOM''
  ) NOT NULL',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Agent-queued sync runs sit in PENDING_AGENT until the on-prem service claims them.
SET @run_col = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'connector_runs'
     AND COLUMN_NAME = 'status'
);
SET @run_sql = IF(@run_col > 0,
  'ALTER TABLE connector_runs MODIFY COLUMN status ENUM(
    ''PENDING_AGENT'',''RUNNING'',''SUCCESS'',''FAILED'',''PARTIAL''
  ) NOT NULL DEFAULT ''RUNNING''',
  'SELECT 1');
PREPARE run_stmt FROM @run_sql;
EXECUTE run_stmt;
DEALLOCATE PREPARE run_stmt;
