-- 044_radius_vpn.sql — RADIUS / VPN network authentication module
-- IdP acts as AAA backend for VPN gateways (AnyConnect, GlobalProtect, FortiClient, etc.)
-- via FreeRADIUS rlm_rest and/or an optional UDP RADIUS listener.

CREATE TABLE IF NOT EXISTS radius_clients (
  id              VARCHAR(36)  NOT NULL PRIMARY KEY,
  name            VARCHAR(150) NOT NULL,
  nas_ip          VARCHAR(64)  NOT NULL COMMENT 'NAS IP or CIDR (e.g. 10.0.0.5 or 10.0.0.0/24)',
  shared_secret   TEXT         NOT NULL COMMENT 'AES-GCM sealed shared secret',
  client_type     ENUM('VPN','WIRELESS','SWITCH','OTHER') NOT NULL DEFAULT 'VPN',
  vendor          VARCHAR(80)  DEFAULT NULL COMMENT 'cisco_anyconnect|globalprotect|fortinet|openvpn|other',
  description     VARCHAR(512) DEFAULT NULL,
  active          TINYINT(1)   NOT NULL DEFAULT 1,
  created_by      VARCHAR(20)  DEFAULT NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_radius_client_nas (nas_ip),
  KEY idx_radius_client_active (active, client_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS radius_auth_policies (
  id                 VARCHAR(36)  NOT NULL PRIMARY KEY,
  name               VARCHAR(150) NOT NULL,
  description        TEXT         DEFAULT NULL,
  priority           INT          NOT NULL DEFAULT 100 COMMENT 'Lower = evaluated first',
  client_type        ENUM('VPN','WIRELESS','SWITCH','OTHER','ANY') NOT NULL DEFAULT 'ANY',
  vendor             VARCHAR(80)  DEFAULT NULL,
  group_ids_json     JSON         DEFAULT NULL COMMENT 'Allowed identity group IDs; empty/null = all',
  require_mfa        TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '1 = password must include TOTP (append or \\ split)',
  require_mfa_enrolled TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = user must have MFA enrolled',
  reply_attributes   JSON         DEFAULT NULL COMMENT 'RADIUS reply attrs e.g. Filter-Id, Tunnel-Private-Group-Id',
  active             TINYINT(1)   NOT NULL DEFAULT 1,
  created_by         VARCHAR(20)  DEFAULT NULL,
  created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_radius_pol_priority (active, priority)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS vpn_profiles (
  id                 VARCHAR(36)  NOT NULL PRIMARY KEY,
  name               VARCHAR(150) NOT NULL,
  slug               VARCHAR(80)  NOT NULL,
  vendor             VARCHAR(80)  NOT NULL DEFAULT 'other',
  description        TEXT         DEFAULT NULL,
  radius_client_id   VARCHAR(36)  DEFAULT NULL,
  saml_sp_id         VARCHAR(36)  DEFAULT NULL COMMENT 'Optional SAML SP for browser VPN SSO',
  policy_id          VARCHAR(36)  DEFAULT NULL,
  connection_hint    VARCHAR(255) DEFAULT NULL COMMENT 'Portal / gateway hostname shown to admins',
  instructions       TEXT         DEFAULT NULL,
  active             TINYINT(1)   NOT NULL DEFAULT 1,
  created_by         VARCHAR(20)  DEFAULT NULL,
  created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_vpn_profile_slug (slug),
  KEY idx_vpn_profile_active (active),
  CONSTRAINT fk_vpn_radius_client FOREIGN KEY (radius_client_id) REFERENCES radius_clients (id) ON DELETE SET NULL,
  CONSTRAINT fk_vpn_policy FOREIGN KEY (policy_id) REFERENCES radius_auth_policies (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS radius_auth_log (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ts                  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  result              ENUM('ACCEPT','REJECT','CHALLENGE','ERROR') NOT NULL,
  reason              VARCHAR(120) DEFAULT NULL,
  username            VARCHAR(255) NOT NULL,
  emp_id              VARCHAR(20)  DEFAULT NULL,
  nas_ip              VARCHAR(64)  DEFAULT NULL,
  client_id           VARCHAR(36)  DEFAULT NULL,
  calling_station_id  VARCHAR(128) DEFAULT NULL,
  policy_id           VARCHAR(36)  DEFAULT NULL,
  protocol            ENUM('REST','UDP') NOT NULL DEFAULT 'REST',
  reply_json          JSON         DEFAULT NULL,
  KEY idx_radius_log_ts (ts DESC),
  KEY idx_radius_log_user (username, ts DESC),
  KEY idx_radius_log_result (result, ts DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed default VPN policy (password + optional MFA append later via admin UI)
INSERT INTO radius_auth_policies (id, name, description, priority, client_type, require_mfa, require_mfa_enrolled, reply_attributes, active)
SELECT 'rad-pol-default-vpn', 'Default VPN access', 'Allow ACTIVE identities for VPN NAS clients', 100, 'VPN', 0, 0,
       JSON_OBJECT('Session-Timeout', '28800', 'Filter-Id', 'vpn-users'), 1
WHERE NOT EXISTS (SELECT 1 FROM radius_auth_policies WHERE id = 'rad-pol-default-vpn');
