-- 018_identity_group_app_access.sql
-- Allow Application Access Policy assignments to target Identity groups (groups table).

ALTER TABLE app_access_assignments
  MODIFY assignment_type ENUM('USER','TAG_GROUP','GROUP') NOT NULL;
