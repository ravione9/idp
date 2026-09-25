/**
 * Boot-time schema repair for drift between lilg_schema_migrations and live DDL.
 * Runs after migrations (or when SKIP_MIGRATIONS_ON_BOOT defers to an external Job).
 */
import { queryOne, execute } from './connection.js';
import logger from '../utils/logger.js';

async function columnExists(tableName: string, columnName: string): Promise<boolean> {
  const row = await queryOne<{ c: number }>(
    `SELECT COUNT(*) AS c
       FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = ?
        AND column_name = ?`,
    [tableName, columnName],
  );
  return Number(row?.c ?? 0) > 0;
}

export async function repairSchemaDrift(): Promise<void> {
  if (!(await columnExists('saml_service_providers', 'default_relay_state'))) {
    logger.warn('Schema repair: adding saml_service_providers.default_relay_state');
    await execute(
      `ALTER TABLE saml_service_providers
         ADD COLUMN default_relay_state VARCHAR(512) NULL AFTER slo_url`,
      [],
    );
    logger.info('Schema repair: saml_service_providers.default_relay_state added');
  }

  if (!(await columnExists('applications', 'icon_data'))) {
    logger.warn('Schema repair: adding applications.icon_data');
    await execute(
      `ALTER TABLE applications
         ADD COLUMN icon_data MEDIUMBLOB NULL COMMENT 'Uploaded app icon bytes (png/jpeg/webp/gif)'`,
      [],
    );
    logger.info('Schema repair: applications.icon_data added');
  }

  if (!(await columnExists('applications', 'icon_mime'))) {
    logger.warn('Schema repair: adding applications.icon_mime');
    await execute(
      `ALTER TABLE applications
         ADD COLUMN icon_mime VARCHAR(64) NULL COMMENT 'MIME type of icon_data'`,
      [],
    );
    logger.info('Schema repair: applications.icon_mime added');
  }

  if (!(await columnExists('applications', 'allow_all_users'))) {
    logger.warn('Schema repair: adding applications.allow_all_users');
    await execute(
      `ALTER TABLE applications
         ADD COLUMN allow_all_users TINYINT(1) NOT NULL DEFAULT 0
           COMMENT '1 = any ACTIVE/REACTIVATED user may launch (Access Policy)'`,
      [],
    );
    logger.info('Schema repair: applications.allow_all_users added');
  }

  if (!(await columnExists('employees', 'mfa_grace_started_at'))) {
    logger.warn('Schema repair: adding employees.mfa_grace_started_at');
    await execute(
      `ALTER TABLE employees
         ADD COLUMN mfa_grace_started_at DATETIME DEFAULT NULL
           COMMENT 'UTC when MFA enrollment grace first started; NULL = not started'`,
      [],
    );
    logger.info('Schema repair: employees.mfa_grace_started_at added');
  }
}
