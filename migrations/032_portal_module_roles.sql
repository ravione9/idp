-- Portal console roles with per-module read/write (no PAM — not designed yet).
-- Built-ins: SUPER_ADMIN, ADMIN, APP_CONTRIBUTOR, USER_GROUP_MANAGER + custom roles.

CREATE TABLE IF NOT EXISTS portal_roles (
  id            VARCHAR(36)  NOT NULL PRIMARY KEY,
  role_key      VARCHAR(64)  NOT NULL,
  name          VARCHAR(128) NOT NULL,
  description   VARCHAR(512) NULL,
  is_system     TINYINT(1)   NOT NULL DEFAULT 0,
  active        TINYINT(1)   NOT NULL DEFAULT 1,
  created_by    VARCHAR(64)  NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_portal_roles_key (role_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS portal_role_permissions (
  role_id     VARCHAR(36) NOT NULL,
  module_key  VARCHAR(64) NOT NULL,
  can_read    TINYINT(1)  NOT NULL DEFAULT 0,
  can_write   TINYINT(1)  NOT NULL DEFAULT 0,
  PRIMARY KEY (role_id, module_key),
  CONSTRAINT fk_prp_role FOREIGN KEY (role_id) REFERENCES portal_roles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Expand local_accounts.role for new built-ins + CUSTOM
ALTER TABLE local_accounts
  MODIFY COLUMN role ENUM(
    'USER','MANAGER','HRBP',
    'ADMIN','SUPER_ADMIN',
    'APP_CONTRIBUTOR','USER_GROUP_MANAGER','CUSTOM'
  ) NOT NULL DEFAULT 'USER';

-- Optional link to portal_roles (required when role = CUSTOM; also set for built-ins)
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'local_accounts'
     AND COLUMN_NAME = 'portal_role_id'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE local_accounts ADD COLUMN portal_role_id VARCHAR(36) NULL AFTER role',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Seed built-in roles (idempotent)
INSERT IGNORE INTO portal_roles (id, role_key, name, description, is_system, active) VALUES
  ('pr-super-admin', 'SUPER_ADMIN', 'Super Admin',
   'Full console access including Administrators and License. Privileged Access (PAM) is not available yet.', 1, 1),
  ('pr-admin', 'ADMIN', 'Admin',
   'Full console access except Administrators page and License. No PAM (not designed yet).', 1, 1),
  ('pr-app-contributor', 'APP_CONTRIBUTOR', 'Application Contributor',
   'Manage applications, access policy, and related reports.', 1, 1),
  ('pr-user-group-mgr', 'USER_GROUP_MANAGER', 'User and Group Manager',
   'Manage users/identities and groups.', 1, 1);

-- Helper: wipe + reseed permissions for a system role (safe re-run)
DELETE FROM portal_role_permissions WHERE role_id IN (
  'pr-super-admin','pr-admin','pr-app-contributor','pr-user-group-mgr'
);

-- All console modules (PAM intentionally omitted)
-- overview, identity_users, identity_groups, applications, authentication,
-- connections, access_model, governance, workflows, reports, settings, administrators

INSERT INTO portal_role_permissions (role_id, module_key, can_read, can_write) VALUES
  -- SUPER_ADMIN: everything including administrators
  ('pr-super-admin','overview',1,1),
  ('pr-super-admin','identity_users',1,1),
  ('pr-super-admin','identity_groups',1,1),
  ('pr-super-admin','applications',1,1),
  ('pr-super-admin','authentication',1,1),
  ('pr-super-admin','connections',1,1),
  ('pr-super-admin','access_model',1,1),
  ('pr-super-admin','governance',1,1),
  ('pr-super-admin','workflows',1,1),
  ('pr-super-admin','reports',1,1),
  ('pr-super-admin','settings',1,1),
  ('pr-super-admin','administrators',1,1),
  -- ADMIN: full ops, no Administrators / License (administrators module)
  ('pr-admin','overview',1,1),
  ('pr-admin','identity_users',1,1),
  ('pr-admin','identity_groups',1,1),
  ('pr-admin','applications',1,1),
  ('pr-admin','authentication',1,1),
  ('pr-admin','connections',1,1),
  ('pr-admin','access_model',1,1),
  ('pr-admin','governance',1,1),
  ('pr-admin','workflows',1,1),
  ('pr-admin','reports',1,1),
  ('pr-admin','settings',1,1),
  -- Application Contributor
  ('pr-app-contributor','overview',1,0),
  ('pr-app-contributor','applications',1,1),
  ('pr-app-contributor','access_model',1,1),
  ('pr-app-contributor','reports',1,0),
  -- User and Group Manager
  ('pr-user-group-mgr','overview',1,0),
  ('pr-user-group-mgr','identity_users',1,1),
  ('pr-user-group-mgr','identity_groups',1,1),
  ('pr-user-group-mgr','reports',1,0);

-- Backfill portal_role_id from legacy role column
UPDATE local_accounts SET portal_role_id = 'pr-super-admin' WHERE role = 'SUPER_ADMIN' AND (portal_role_id IS NULL OR portal_role_id = '');
UPDATE local_accounts SET portal_role_id = 'pr-admin' WHERE role = 'ADMIN' AND (portal_role_id IS NULL OR portal_role_id = '');
