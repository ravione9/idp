/**
 * Standalone migration runner — executed by the K8s migration Job.
 *   node dist/db/migrate-cli.js
 */
import { runMigrations } from './migrate.js';
import logger from '../utils/logger.js';

runMigrations()
  .then(() => {
    logger.info('Migrations complete');
    process.exit(0);
  })
  .catch((err) => {
    logger.fatal({ err }, 'Migrations failed');
    process.exit(1);
  });
