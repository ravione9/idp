-- 004_seed_zoho_mail_saml_app.sql
-- Pre-register Zoho Mail as a SAML Service Provider (this IdP issues
-- assertions to Zoho Mail). Zoho is no longer used as a portal login
-- provider — see ARCHITECTURE.md change log.
--
-- The Entity ID and ACS URL below are Zoho's standard SAML SP endpoints.
-- After applying this migration, ensure the IdP signing keys are present
-- (SAML_IDP_PRIVATE_KEY_PEM / SAML_IDP_CERT_PEM) and hand the SP admin the
-- IdP metadata at GET /saml/metadata.

INSERT INTO saml_service_providers
  (id, name, slug, entity_id, acs_url, slo_url,
   nameid_format, attribute_map, entitlement_rule, icon_url, sort_order, active)
SELECT
  UUID(),
  'Zoho Mail',
  'zoho-mail',
  'zoho.com',
  'https://accounts.zoho.in/signin/samlsp',
  'https://accounts.zoho.in/signin/samlsp/logout',
  'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  JSON_OBJECT(
    'EmailAddress', 'email_corp',
    'FirstName',    'full_name',
    'DisplayName',  'full_name'
  ),
  JSON_OBJECT('all_active', true),
  'https://www.zoho.com/sites/zweb/images/zohomail/zoho-mail-icon.svg',
  10,
  1
WHERE NOT EXISTS (
  SELECT 1 FROM saml_service_providers WHERE slug = 'zoho-mail'
);

-- Mirror into the new generic application catalog (003 schema) so that the
-- SAML app shows up in /api/iga/applications too.
INSERT INTO applications
  (id, slug, name, description, icon_url, category,
   visibility, sso_enabled, provisioning, sort_order, active)
SELECT
  UUID(),
  'zoho-mail',
  'Zoho Mail',
  'Corporate mailbox for @lenskart domains. Single sign-on via SAML 2.0 issued by Lenskart IdP.',
  'https://www.zoho.com/sites/zweb/images/zohomail/zoho-mail-icon.svg',
  'Productivity',
  'PUBLIC',
  1, 0, 10, 1
WHERE NOT EXISTS (
  SELECT 1 FROM applications WHERE slug = 'zoho-mail'
);

-- Bind the SAML protocol config (config payload mirrors the SP record above).
INSERT INTO app_protocol_configs (id, app_id, protocol, config, active)
SELECT
  UUID(),
  a.id,
  'SAML',
  JSON_OBJECT(
    'entity_id',    'zoho.com',
    'acs_url',      'https://accounts.zoho.in/signin/samlsp',
    'slo_url',      'https://accounts.zoho.in/signin/samlsp/logout',
    'nameid_format','urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    'attribute_map', JSON_OBJECT(
      'EmailAddress','email_corp',
      'FirstName',   'full_name',
      'DisplayName', 'full_name'
    )
  ),
  1
FROM applications a
WHERE a.slug = 'zoho-mail'
  AND NOT EXISTS (
    SELECT 1 FROM app_protocol_configs c WHERE c.app_id = a.id AND c.protocol = 'SAML'
  );
