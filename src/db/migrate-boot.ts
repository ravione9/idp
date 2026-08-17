/**
 * Boot-time migration gate for the API process.
 * Default: run pending migrations on boot (already-applied files in
 * lilg_schema_migrations are skipped). Set SKIP_MIGRATIONS_ON_BOOT=true only
 * when an external Job owns schema exclusively.
 */
import { runMigrations } from './migrate.js';
import { repairSchemaDrift } from './schema-repair.js';
import logger from '../utils/logger.js';

export async function maybeRunBootMigrations(skipMigrationsOnBoot: boolean): Promise<void> {
  if (skipMigrationsOnBoot) {
    logger.info('SKIP_MIGRATIONS_ON_BOOT=true — migrations handled externally (K8s Job)');
  } else {
    logger.info('Running database migrations on boot (skipping already-applied)');
    await runMigrations();
  }
  await repairSchemaDrift();
}
