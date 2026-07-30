-- 033: Universal Directory — extended employee attrs, Google attribute maps, sync settings, field audit

-- Extended profile attributes on employees
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS first_name       VARCHAR(100) NULL AFTER full_name,
  ADD COLUMN IF NOT EXISTS last_name        VARCHAR(100) NULL AFTER first_name,
  ADD COLUMN IF NOT EXISTS username         VARCHAR(100) NULL AFTER last_name,
  ADD COLUMN IF NOT EXISTS employee_number  VARCHAR(64)  NULL AFTER emp_id,
  ADD COLUMN IF NOT EXISTS mobile           VARCHAR(40)  NULL AFTER country,
  ADD COLUMN IF NOT EXISTS cost_center      VARCHAR(80)  NULL AFTER mobile,
  ADD COLUMN IF NOT EXISTS location         VARCHAR(200) NULL AFTER cost_center,
  ADD COLUMN IF NOT EXISTS office_address   TEXT         NULL AFTER location,
  ADD COLUMN IF NOT EXISTS photo_url        VARCHAR(500) NULL AFTER office_address,
  ADD COLUMN IF NOT EXISTS attrs_synced_at  DATETIME     NULL AFTER photo_url,
  ADD COLUMN IF NOT EXISTS sync_status      VARCHAR(30)  NULL AFTER attrs_synced_at;

-- Idempotent-friendly indexes for new lookup columns
CREATE INDEX idx_employees_employee_number ON employees (employee_number);
CREATE INDEX idx_employees_username ON employees (username);

-- Google (and future) attribute mapping: source_attr → local_attr
CREATE TABLE IF NOT EXISTS directory_attr_maps (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  source_system VARCHAR(32)  NOT NULL DEFAULT 'GOOGLE',
  source_attr   VARCHAR(120) NOT NULL,
  local_attr    VARCHAR(80)  NOT NULL,
  enabled       TINYINT(1)   NOT NULL DEFAULT 1,
  sort_order    INT          NOT NULL DEFAULT 0,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_dir_attr_map (source_system, source_attr),
  KEY idx_dir_attr_local (source_system, local_attr)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Sync toggles + frequency for directory sources
CREATE TABLE IF NOT EXISTS directory_sync_settings (
  source_system        VARCHAR(32)  NOT NULL PRIMARY KEY,
  sync_employee_id     TINYINT(1)   NOT NULL DEFAULT 1,
  sync_department      TINYINT(1)   NOT NULL DEFAULT 1,
  sync_designation     TINYINT(1)   NOT NULL DEFAULT 1,
  sync_manager         TINYINT(1)   NOT NULL DEFAULT 1,
  sync_cost_center     TINYINT(1)   NOT NULL DEFAULT 1,
  sync_mobile          TINYINT(1)   NOT NULL DEFAULT 1,
  sync_location        TINYINT(1)   NOT NULL DEFAULT 1,
  sync_profile_photo   TINYINT(1)   NOT NULL DEFAULT 1,
  sync_office_address  TINYINT(1)   NOT NULL DEFAULT 1,
  frequency            VARCHAR(16)  NOT NULL DEFAULT 'manual',
  disable_deleted      TINYINT(1)   NOT NULL DEFAULT 0,
  updated_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by           VARCHAR(64)  NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO directory_sync_settings (source_system)
VALUES ('GOOGLE')
ON DUPLICATE KEY UPDATE source_system = source_system;

-- Default Google → local attribute map
INSERT INTO directory_attr_maps (source_system, source_attr, local_attr, enabled, sort_order) VALUES
  ('GOOGLE', 'employeeId',                'employee_number', 1, 10),
  ('GOOGLE', 'organizations.department',  'dept_id',         1, 20),
  ('GOOGLE', 'organizations.title',       'role',            1, 30),
  ('GOOGLE', 'organizations.costCenter',  'cost_center',     1, 40),
  ('GOOGLE', 'organizations.location',    'location',        1, 50),
  ('GOOGLE', 'manager',                   'manager_emp_id',  1, 60),
  ('GOOGLE', 'phones',                    'mobile',          1, 70),
  ('GOOGLE', 'addresses',                 'office_address',  1, 80),
  ('GOOGLE', 'thumbnailPhotoUrl',         'photo_url',       1, 90),
  ('GOOGLE', 'name.givenName',            'first_name',      1, 100),
  ('GOOGLE', 'name.familyName',           'last_name',       1, 110),
  ('GOOGLE', 'primaryEmail',              'email_corp',      1, 120)
ON DUPLICATE KEY UPDATE local_attr = VALUES(local_attr), enabled = VALUES(enabled);

-- Field-level change audit for directory ops
CREATE TABLE IF NOT EXISTS directory_user_audit (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  emp_id        VARCHAR(20)  NULL,
  action        VARCHAR(64)  NOT NULL,
  admin_emp_id  VARCHAR(20)  NULL,
  source        VARCHAR(32)  NULL,
  changed_fields JSON        NULL,
  old_values    JSON         NULL,
  new_values    JSON         NULL,
  detail        JSON         NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_dir_audit_emp (emp_id),
  KEY idx_dir_audit_action (action),
  KEY idx_dir_audit_ts (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
