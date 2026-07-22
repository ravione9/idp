-- 040: SAML apps must be Access-Policy gated (RESTRICTED + no open birthright)
-- Fixes SSO allowing any active IdP user when apps were PUBLIC / all_active / unmirrored.

-- Mirror any SAML SP missing from applications as RESTRICTED
INSERT INTO applications (id, slug, name, icon_url, category, visibility, sso_enabled, provisioning, sort_order, active)
SELECT UUID(), sp.slug, sp.name, sp.icon_url, 'SSO', 'RESTRICTED', 1, 0, sp.sort_order, sp.active
  FROM saml_service_providers sp
 WHERE NOT EXISTS (SELECT 1 FROM applications a WHERE a.slug = sp.slug);

-- Force RESTRICTED on every catalog row that backs a SAML SP
UPDATE applications a
  INNER JOIN saml_service_providers sp ON sp.slug = a.slug
   SET a.visibility = 'RESTRICTED',
       a.sso_enabled = 1
 WHERE a.visibility <> 'RESTRICTED' OR a.sso_enabled <> 1;

-- Turn off open birthright on SAML entitlement_rule (preserve other JSON keys)
UPDATE saml_service_providers
   SET entitlement_rule = JSON_SET(
         COALESCE(entitlement_rule, JSON_OBJECT()),
         '$.all_active',
         false
       )
 WHERE JSON_EXTRACT(entitlement_rule, '$.all_active') IS NULL
    OR JSON_EXTRACT(entitlement_rule, '$.all_active') = true
    OR JSON_TYPE(JSON_EXTRACT(entitlement_rule, '$.all_active')) = 'NULL';
