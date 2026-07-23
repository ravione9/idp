-- 043: Per-application IP/CIDR allowlist for SSO launch
-- NULL or empty JSON array = no IP restriction (anyone with a grant may launch).
-- Non-empty = client IP must match at least one CIDR / exact IP / prefix.

ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS allowed_cidrs JSON NULL
    COMMENT 'JSON array of IPv4 CIDRs/IPs; empty/null = unrestricted'
    AFTER visibility;
