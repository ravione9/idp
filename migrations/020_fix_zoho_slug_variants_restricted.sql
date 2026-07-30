-- 020_fix_zoho_slug_variants_restricted.sql
-- Some environments use Zoho slug/name variants (zoho-mail vs zoho_mail).
-- Force policy-gated behavior for all Zoho Mail variants so users without
-- explicit Application Access Policy grants cannot see/launch the app.

UPDATE saml_service_providers
   SET entitlement_rule = JSON_OBJECT('all_active', false)
 WHERE slug IN ('zoho-mail', 'zoho_mail')
    OR LOWER(REPLACE(name, '_', ' ')) = 'zoho mail';

UPDATE applications
   SET visibility = 'RESTRICTED'
 WHERE slug IN ('zoho-mail', 'zoho_mail')
    OR LOWER(REPLACE(name, '_', ' ')) = 'zoho mail';
