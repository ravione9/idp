-- 013_app_access_policy.sql
-- Application Access Policy: user/tag-group assignments, approval workflows, audit log.

CREATE TABLE IF NOT EXISTS tag_groups (
  id          VARCHAR(36)  NOT NULL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  tags        JSON         NOT NULL COMMENT 'Array of tag strings for group classification',
  active      TINYINT(1)   NOT NULL DEFAULT 1,
  created_by  VARCHAR(20),
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_tag_group_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tag_group_members (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tag_group_id VARCHAR(36)     NOT NULL,
  emp_id       VARCHAR(20)     NOT NULL,
  added_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  added_by     VARCHAR(20),
  UNIQUE KEY uq_tgm (tag_group_id, emp_id),
  KEY idx_tgm_emp (emp_id),
  CONSTRAINT fk_tgm_group FOREIGN KEY (tag_group_id) REFERENCES tag_groups (id) ON DELETE CASCADE,
  CONSTRAINT fk_tgm_emp FOREIGN KEY (emp_id) REFERENCES employees (emp_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS app_access_assignments (
  id               VARCHAR(36) NOT NULL PRIMARY KEY,
  app_id           VARCHAR(36) NOT NULL,
  assignment_type  ENUM('USER','TAG_GROUP') NOT NULL,
  target_id        VARCHAR(36) NOT NULL COMMENT 'emp_id when USER; tag_group_id when TAG_GROUP',
  active           TINYINT(1)  NOT NULL DEFAULT 1,
  granted_by       VARCHAR(20),
  granted_at       DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at       DATETIME    DEFAULT NULL,
  revoked_by       VARCHAR(20) DEFAULT NULL,
  UNIQUE KEY uk_app_assign (app_id, assignment_type, target_id),
  KEY idx_assign_app (app_id, active),
  KEY idx_assign_target (assignment_type, target_id),
  CONSTRAINT fk_assign_app FOREIGN KEY (app_id) REFERENCES applications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS app_group_access_workflows (
  id               VARCHAR(36) NOT NULL PRIMARY KEY,
  app_id           VARCHAR(36) NOT NULL,
  tag_group_id     VARCHAR(36) DEFAULT NULL,
  name             VARCHAR(150) NOT NULL,
  approval_levels  JSON        NOT NULL COMMENT '[{level, approverType, approverEmpId?}]',
  auto_provision   TINYINT(1)  NOT NULL DEFAULT 1,
  active           TINYINT(1)  NOT NULL DEFAULT 1,
  created_by       VARCHAR(20),
  created_at       DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_wf_app (app_id, active),
  CONSTRAINT fk_wf_app FOREIGN KEY (app_id) REFERENCES applications (id) ON DELETE CASCADE,
  CONSTRAINT fk_wf_tag_group FOREIGN KEY (tag_group_id) REFERENCES tag_groups (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS app_access_audit_log (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  app_id        VARCHAR(36)     DEFAULT NULL,
  action        ENUM('ASSIGN_USER','ASSIGN_GROUP','REVOKE','REQUEST','APPROVE','REJECT','PROVISION') NOT NULL,
  actor_emp_id  VARCHAR(20)     DEFAULT NULL,
  target_emp_id VARCHAR(20)     DEFAULT NULL,
  tag_group_id  VARCHAR(36)     DEFAULT NULL,
  request_id    VARCHAR(36)     DEFAULT NULL,
  details       JSON            DEFAULT NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_app (app_id, created_at DESC),
  KEY idx_audit_action (action, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Align access_requests.item_type with IGA API (APP_ACCESS)
ALTER TABLE access_requests
  MODIFY item_type ENUM('ENTITLEMENT','ROLE','APPLICATION','APP_ACCESS') NOT NULL;
