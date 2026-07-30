-- 041: MFA remember-device policy (skip MFA on trusted browser for N hours)
INSERT IGNORE INTO mfa_policy (policy_key, policy_value) VALUES
  ('remember_device_hours', '24');
