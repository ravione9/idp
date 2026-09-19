-- 067_employees_dept_role_widen.sql
-- Google / AD department and title values often exceed VARCHAR(50).

SET @db := DATABASE();

SET @sql := (
  SELECT IF(
    (SELECT DATA_TYPE FROM information_schema.columns
      WHERE table_schema = @db AND table_name = 'employees' AND column_name = 'dept_id') = 'varchar'
    AND (SELECT CHARACTER_MAXIMUM_LENGTH FROM information_schema.columns
      WHERE table_schema = @db AND table_name = 'employees' AND column_name = 'dept_id') < 255,
    'ALTER TABLE employees MODIFY COLUMN dept_id VARCHAR(255) DEFAULT NULL',
    'SELECT 1'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := (
  SELECT IF(
    (SELECT DATA_TYPE FROM information_schema.columns
      WHERE table_schema = @db AND table_name = 'employees' AND column_name = 'role') = 'varchar'
    AND (SELECT CHARACTER_MAXIMUM_LENGTH FROM information_schema.columns
      WHERE table_schema = @db AND table_name = 'employees' AND column_name = 'role') < 255,
    'ALTER TABLE employees MODIFY COLUMN role VARCHAR(255) DEFAULT NULL',
    'SELECT 1'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
