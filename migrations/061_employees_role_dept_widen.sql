-- 061: Widen employees.role and dept_id for long Google Workspace titles / department names

ALTER TABLE employees
  MODIFY COLUMN role    VARCHAR(255) NULL,
  MODIFY COLUMN dept_id VARCHAR(128) NULL;
