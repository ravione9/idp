-- 062_ad_object_guid.sql
-- Store AD objectGUID on employees for SAML SPs (e.g. Autodesk) that require objectGUID.

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS ad_object_guid VARCHAR(36) NULL AFTER last_name;

CREATE INDEX IF NOT EXISTS idx_employees_ad_object_guid ON employees (ad_object_guid);
