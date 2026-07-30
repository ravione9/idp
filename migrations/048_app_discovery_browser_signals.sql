-- 048 — App Discovery: browser signals (no static SaaS wishlist)
-- Browsers do not expose HTTP cache/history to websites; we persist
-- referrer / resource / launch hints reported by the portal SPA.

ALTER TABLE discovered_apps
  MODIFY COLUMN source ENUM('MANUAL','CATALOG_GAP','SSO_SIGNAL','IMPORT','BROWSER')
    NOT NULL DEFAULT 'MANUAL';

CREATE TABLE IF NOT EXISTS browser_app_signals (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  emp_id        VARCHAR(20)  NOT NULL,
  domain        VARCHAR(255) NOT NULL,
  signal_type   VARCHAR(40)  NOT NULL DEFAULT 'referrer',
  hit_count     INT UNSIGNED NOT NULL DEFAULT 1,
  first_seen_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
  last_seen_at  DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
  UNIQUE KEY uq_browser_signal (emp_id, domain, signal_type),
  KEY idx_browser_signal_domain (domain),
  KEY idx_browser_signal_seen (last_seen_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
