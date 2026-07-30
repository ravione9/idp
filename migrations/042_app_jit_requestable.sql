-- 042: JIT / Request Access — mark apps requestable + restrict who may request via workflow

ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS requestable TINYINT(1) NOT NULL DEFAULT 0
    COMMENT '1 = eligible for self-service Request Access (JIT) catalog'
    AFTER visibility;

ALTER TABLE app_group_access_workflows
  ADD COLUMN IF NOT EXISTS requester_group_ids JSON NULL
    COMMENT 'Identity group UUIDs allowed to submit requests; empty/null = any authenticated user'
    AFTER approval_levels;
