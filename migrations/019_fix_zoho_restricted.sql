-- 019_fix_zoho_restricted.sql
-- Migration 017 ran but the JSON boolean WHERE clause may not have matched
-- on all MySQL versions. This migration unconditionally ensures zoho-mail
-- is policy-gated so users without an explicit Application Access Policy
-- assignment cannot see or launch it.

UPDATE saml_service_providers
   SET entitlement_rule = JSON_OBJECT('all_active', false)
 WHERE slug = 'zoho-mail';

UPDATE applications
   SET visibility = 'RESTRICTED'
 WHERE slug = 'zoho-mail';
