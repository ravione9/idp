-- 047 — App Discovery (shadow IT / unsanctioned SaaS inventory)
-- Sources: manual entry, catalog gap scan (known SaaS), SSO usage signals.

CREATE TABLE IF NOT EXISTS discovered_apps (
  id              VARCHAR(36)  NOT NULL PRIMARY KEY,
  name            VARCHAR(200) NOT NULL,
  domain          VARCHAR(255) NOT NULL,
  category        VARCHAR(80)  DEFAULT NULL,
  source          ENUM('MANUAL','CATALOG_GAP','SSO_SIGNAL','IMPORT') NOT NULL DEFAULT 'MANUAL',
  status          ENUM('NEW','REVIEWING','SANCTIONED','IGNORED') NOT NULL DEFAULT 'NEW',
  risk_level      ENUM('LOW','MEDIUM','HIGH','UNKNOWN') NOT NULL DEFAULT 'UNKNOWN',
  user_count      INT UNSIGNED NOT NULL DEFAULT 0,
  hit_count       INT UNSIGNED NOT NULL DEFAULT 0,
  first_seen_at   DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
  last_seen_at    DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
  evidence_json   JSON DEFAULT NULL,
  notes           TEXT DEFAULT NULL,
  linked_app_id   VARCHAR(36) DEFAULT NULL,
  created_by      VARCHAR(20) DEFAULT NULL,
  updated_at      DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()) ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_discovered_domain (domain),
  KEY idx_disc_status (status, last_seen_at DESC),
  KEY idx_disc_source (source),
  KEY idx_disc_linked (linked_app_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
