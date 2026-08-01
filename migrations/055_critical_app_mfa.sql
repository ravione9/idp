-- 055: Application-level MFA for critical apps
-- Global kill-switch in mfa_policy; per-app flag on applications (mirrored SAML/OIDC catalog).

ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS require_mfa TINYINT(1) NOT NULL DEFAULT 0
    COMMENT '1 = critical app: require fresh MFA at SSO launch when policy critical_app_mfa is on'
    AFTER risk_score;

ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS mfa_step_up_max_age_seconds INT NOT NULL DEFAULT 300
    COMMENT 'MFA must have been verified within this many seconds before SSO launch (0 = every launch)'
    AFTER require_mfa;

INSERT IGNORE INTO mfa_policy (policy_key, policy_value) VALUES
  ('critical_app_mfa', '1'),
  ('critical_app_mfa_max_age_seconds', '300');
