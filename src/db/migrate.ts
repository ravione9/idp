/**
 * Lightweight SQL migration runner.
 *
 * Reads `migrations/NNN_name.sql` files in order, applies any that are not
 * yet recorded in the `lilg_schema_migrations` table, and tracks them.
 *
 * Idempotent — safe to run on every startup. Each migration file is executed
 * as a single multi-statement batch, so it should be one logical change.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { config } from '../config.js';
import logger from '../utils/logger.js';

const MIGRATIONS_TABLE = 'lilg_schema_migrations';

function migrationsDir(): string {
  // dist/db/migrate.js  →  ../../migrations
  // src/db/migrate.ts   →  ../../migrations (when running ts-node)
  return path.resolve(process.cwd(), 'migrations');
}

interface MigrationFile {
  name: string;
  fullPath: string;
  sql: string;
  checksum: string;
}

function loadMigrations(): MigrationFile[] {
  const dir = migrationsDir();
  if (!fs.existsSync(dir)) {
    logger.warn({ dir }, 'No migrations directory — nothing to apply');
    return [];
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  return files.map((f) => {
    const fullPath = path.join(dir, f);
    const sql = fs.readFileSync(fullPath, 'utf8');
    return {
      name:     f,
      fullPath,
      sql,
      checksum: crypto.createHash('sha256').update(sql).digest('hex'),
    };
  });
}

async function ensureTrackingTable(conn: mysql.Connection): Promise<void> {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      name        VARCHAR(255) NOT NULL,
      checksum    CHAR(64)     NOT NULL,
      applied_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      duration_ms INT          NOT NULL DEFAULT 0,
      PRIMARY KEY (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

export async function runMigrations(): Promise<void> {
  // Use a dedicated connection that can handle multi-statement SQL files.
  const conn = await mysql.createConnection({
    host:               config.db.host,
    port:               config.db.port,
    user:               config.db.user,
    password:           config.db.password,
    database:           config.db.database,
    multipleStatements: true,
  });

  try {
    await ensureTrackingTable(conn);

    const migrations = loadMigrations();
    if (migrations.length === 0) {
      logger.info('No migration files found');
      return;
    }

    const [appliedRows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT name, checksum FROM ${MIGRATIONS_TABLE}`,
    );
    const applied = new Map<string, string>();
    for (const r of appliedRows) {
      applied.set(r['name'] as string, r['checksum'] as string);
    }

    let pending = 0;
    for (const m of migrations) {
      const existingChecksum = applied.get(m.name);
      if (existingChecksum !== undefined) {
        if (existingChecksum !== m.checksum) {
          logger.warn({ name: m.name }, 'Migration file changed after apply (checksum mismatch); skipping');
        }
        continue;
      }

      const start = Date.now();
      logger.info({ name: m.name }, 'Applying migration');
      try {
        await conn.query(m.sql);
        const duration = Date.now() - start;
        await conn.query(
          `INSERT INTO ${MIGRATIONS_TABLE} (name, checksum, duration_ms) VALUES (?, ?, ?)`,
          [m.name, m.checksum, duration],
        );
        logger.info({ name: m.name, durationMs: duration }, 'Migration applied');
        pending++;
      } catch (err) {
        logger.error({ name: m.name, err }, 'Migration failed — aborting startup');
        throw err;
      }
    }

    if (pending === 0) {
      logger.info({ total: migrations.length }, 'Schema is up to date');
    } else {
      logger.info({ applied: pending, total: migrations.length }, 'Migrations applied');
    }
  } finally {
    await conn.end();
  }
}
