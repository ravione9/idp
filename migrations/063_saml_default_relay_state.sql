-- 063_saml_default_relay_state.sql
-- Optional default RelayState (post-login redirect / deep link) for IdP-initiated SAML launch.

ALTER TABLE saml_service_providers
  ADD COLUMN IF NOT EXISTS default_relay_state VARCHAR(512) NULL AFTER slo_url;
