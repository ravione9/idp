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
}
