-- 049 — notifications.id must be VARCHAR(36) for UUID inserts from notification.ts
-- Migration 003 created BIGINT AUTO_INCREMENT; service inserts uuidv4() →
-- "Data truncated for column 'id' at row 1" (Email OTP / any sendNotification).

-- Drop AUTO_INCREMENT while keeping values
ALTER TABLE notifications
  MODIFY COLUMN id BIGINT NOT NULL;

-- Convert PK to UUID-compatible string (existing numeric ids become '1','2',…)
ALTER TABLE notifications
  MODIFY COLUMN id VARCHAR(36) NOT NULL;

-- Align channel enum with service ('IN_APP') while keeping legacy 'INAPP'
ALTER TABLE notifications
  MODIFY COLUMN channel ENUM(
    'EMAIL','SLACK','TEAMS','SMS','WEBHOOK','INAPP','IN_APP'
  ) NOT NULL;
