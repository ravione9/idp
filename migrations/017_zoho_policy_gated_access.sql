-- 017_zoho_policy_gated_access.sql
-- Zoho Mail is governed by Application Access Policy, not birthright all_active.
-- Set visibility = RESTRICTED so canUserLaunchApp() requires an explicit grant.

UPDATE saml_service_providers
   SET entitlement_rule = JSON_OBJECT('all_active', false)
 WHERE slug = 'zoho-mail';

UPDATE applications
   SET visibility = 'RESTRICTED'
 WHERE slug = 'zoho-mail';
