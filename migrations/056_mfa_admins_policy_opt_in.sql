-- 056: Administrator MFA is policy-driven (opt-in), not auto-enforced.
-- Previous seed set enforce_for_admins=1; flip default to off so Strong Auth
-- "Always Enforce for Admins" must be enabled explicitly.
-- Idempotent: safe to re-run.

INSERT INTO mfa_policy (policy_key, policy_value)
VALUES ('enforce_for_admins', 'false')
ON DUPLICATE KEY UPDATE policy_value = 'false';
