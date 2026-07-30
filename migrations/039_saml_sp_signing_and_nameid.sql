-- 039: Per-SP SAML signing toggles + NameID source attribute
-- Defaults: sign assertion and response, NameID from email_corp

ALTER TABLE saml_service_providers
  ADD COLUMN IF NOT EXISTS sign_assertions   TINYINT(1)   NOT NULL DEFAULT 1 AFTER attribute_map,
  ADD COLUMN IF NOT EXISTS sign_response     TINYINT(1)   NOT NULL DEFAULT 1 AFTER sign_assertions,
  ADD COLUMN IF NOT EXISTS nameid_attribute  VARCHAR(80)  NULL DEFAULT NULL AFTER sign_response,
  ADD COLUMN IF NOT EXISTS merge_default_attrs TINYINT(1) NOT NULL DEFAULT 1 AFTER nameid_attribute;
