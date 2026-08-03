-- 058: Global Attendance IGA exclusion list (email-based, all policies)

CREATE TABLE IF NOT EXISTS attendance_iga_global_exclusions (
  id          VARCHAR(36)   NOT NULL PRIMARY KEY,
  email       VARCHAR(255)  NOT NULL COMMENT 'Normalized lowercase corporate email',
  emp_id      VARCHAR(20)   NULL COMMENT 'Resolved employee id when known',
  notes       VARCHAR(500)  NULL,
  active      TINYINT(1)    NOT NULL DEFAULT 1,
  created_by  VARCHAR(20)   NULL,
  created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_aig_global_excl_email (email),
  KEY idx_aig_global_excl_emp (emp_id),
  KEY idx_aig_global_excl_active (active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
