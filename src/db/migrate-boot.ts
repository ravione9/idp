/**
 * Boot-time migration gate for the API process.
 * When skip is true (K8s Job owns schema), log and return; otherwise runMigrations().
 */
import { runMigrations } from './migrate.js';
import logger from '../utils/logger.js';

export async function maybeRunBootMigrations(skipMigrationsOnBoot: boolean): Promise<void> {
  if (skipMigrationsOnBoot) {
    logger.info('SKIP_MIGRATIONS_ON_BOOT=true — migrations handled externally (K8s Job)');
    return;
  }
  await runMigrations();
}
