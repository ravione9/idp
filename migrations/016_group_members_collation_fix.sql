-- 016_group_members_collation_fix.sql
-- group_members was created with the server default collation (utf8mb4_0900_ai_ci on
-- MySQL 8) while employees.emp_id uses utf8mb4_unicode_ci — member lookups fail with
-- ER_CANT_AGGREGATE_2COLLATIONS until these columns are aligned.

SET @has_gm := (
  SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'group_members'
);
SET @sql := IF(@has_gm > 0,
  'ALTER TABLE group_members
     MODIFY COLUMN group_id VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
     MODIFY COLUMN emp_id VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
