/**
 * Lightweight SQL migration runner.
 *
 * Reads `migrations/NNN_name.sql` files in order, applies any that are not
 * yet recorded in the `lilg_schema_migrations` table, and tracks them.
 *
 * Idempotent — safe to run on every startup. Each migration file is executed
 * as a single multi-statement batch by default.
 *
 * Compatibility note:
 * Migrations that use `ADD COLUMN IF NOT EXISTS` or `CREATE INDEX IF NOT EXISTS`
 * (unsupported on some MySQL builds) are applied statement-by-statement with
 * information_schema pre-checks. Other files run as a single batch first.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { config } from '../config.js';
import logger from '../utils/logger.js';

const MIGRATIONS_TABLE = 'lilg_schema_migrations';

function splitSqlStatements(sql: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;
  let prev = '';

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    const next = sql[i + 1] ?? '';

    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      prev = ch;
      continue;
    }

    if (inBlockComment) {
      current += ch;
      if (prev === '*' && ch === '/') inBlockComment = false;
      prev = ch;
      continue;
    }

    if (!inSingle && !inDouble && !inBacktick) {
      if (ch === '-' && next === '-') {
        inLineComment = true;
        current += ch;
        prev = ch;
        continue;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        current += ch;
        prev = ch;
        continue;
      }
    }

    if (ch === '\'' && !inDouble && !inBacktick && prev !== '\\') {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle && !inBacktick && prev !== '\\') {
      inDouble = !inDouble;
    } else if (ch === '`' && !inSingle && !inDouble) {
      inBacktick = !inBacktick;
    }

    if (ch === ';' && !inSingle && !inDouble && !inBacktick) {
      parts.push(current);
      current = '';
      prev = '';
      continue;
    }

    current += ch;
    prev = ch;
  }

  if (current.trim()) {
    parts.push(current);
  }

  return parts;
}

function stripSqlLineComments(statement: string): string {
  return statement
    .split('\n')
    .map((line) => line.replace(/^\s*--.*$/, ''))
    .join('\n')
    .trim();
}

function migrationUsesIfNotExistsDdl(sql: string): boolean {
  return (
    /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/i.test(sql)
    || /CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS/i.test(sql)
  );
}

function isUnsupportedIfNotExistsParseError(err: unknown, sql: string): boolean {
  const code = (err as NodeJS.ErrnoException & { code?: string })?.code ?? '';
  const message = (err as Error)?.message ?? '';
  return (
    code === 'ER_PARSE_ERROR'
    && /IF\s+NOT\s+EXISTS/i.test(message)
    && migrationUsesIfNotExistsDdl(sql)
  );
}

function parseAddColumnIfNotExistsClauses(body: string): Array<{ column: string; definition: string }> {
  const clauses: Array<{ column: string; definition: string }> = [];
  const re = /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+`?([A-Za-z0-9_]+)`?\s+([\s\S]*?)(?=(?:,\s*ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b)|$)/gi;
  for (const m of body.matchAll(re)) {
    const column = m[1]?.trim();
    const definition = m[2]?.trim();
    if (!column || !definition) continue;
    clauses.push({ column, definition });
  }
  return clauses;
}

function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

async function applyAddColumnCompatStatement(conn: mysql.Connection, statement: string): Promise<boolean> {
  const normalized = stripSqlLineComments(statement);
  if (!normalized) return true;

  const m = normalized.match(/^ALTER\s+TABLE\s+`?([A-Za-z0-9_]+)`?\s+([\s\S]+)$/i);
  if (!m?.[1] || !m[2]) return false;

  const tableName = m[1].trim();
  const body = m[2];
  const clauses = parseAddColumnIfNotExistsClauses(body);
  if (clauses.length === 0) return false;

  for (const clause of clauses) {
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS c
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND COLUMN_NAME = ?`,
      [tableName, clause.column],
    );
    const exists = Number(rows[0]?.['c'] ?? 0) > 0;
    if (exists) continue;

    await conn.query(
      `ALTER TABLE ${quoteIdent(tableName)} ADD COLUMN ${quoteIdent(clause.column)} ${clause.definition}`,
    );
  }

  return true;
}

async function applyCreateIndexCompatStatement(conn: mysql.Connection, statement: string): Promise<boolean> {
  const normalized = stripSqlLineComments(statement);
  if (!normalized) return true;

  const m = normalized.match(
    /^CREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+`?([A-Za-z0-9_]+)`?\s+ON\s+`?([A-Za-z0-9_]+)`?\s*\(([\s\S]+)\)$/i,
  );
  if (!m?.[2] || !m[3] || !m[4]) return false;

  const unique = Boolean(m[1]);
  const indexName = m[2].trim();
  const tableName = m[3].trim();
  const columns = m[4].trim();

  const [rows] = await conn.query<mysql.RowDataPacket[]>(
    `SELECT COUNT(*) AS c
       FROM information_schema.statistics
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?`,
    [tableName, indexName],
  );
  if (Number(rows[0]?.['c'] ?? 0) > 0) return true;

  const kind = unique ? 'UNIQUE INDEX' : 'INDEX';
  await conn.query(
    `CREATE ${kind} ${quoteIdent(indexName)} ON ${quoteIdent(tableName)} (${columns})`,
  );
  return true;
}

async function applyMigrationStatements(conn: mysql.Connection, migration: MigrationFile): Promise<void> {
  const statements = splitSqlStatements(migration.sql);
  for (const raw of statements) {
    const statement = stripSqlLineComments(raw);
    if (!statement) continue;

    if (await applyAddColumnCompatStatement(conn, statement)) continue;
    if (await applyCreateIndexCompatStatement(conn, statement)) continue;

    await conn.query(statement);
  }
}

async function applyMigrationSql(conn: mysql.Connection, migration: MigrationFile): Promise<void> {
  if (migrationUsesIfNotExistsDdl(migration.sql)) {
    logger.info(
      { name: migration.name },
      'Applying migration with IF NOT EXISTS compatibility mode',
    );
    await applyMigrationStatements(conn, migration);
    return;
  }

  try {
    await conn.query(migration.sql);
  } catch (err) {
    if (!isUnsupportedIfNotExistsParseError(err, migration.sql)) {
      throw err;
    }
    logger.warn(
      { name: migration.name },
      'Retrying migration with compatibility mode for IF NOT EXISTS DDL',
    );
    await applyMigrationStatements(conn, migration);
  }
}

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
  const connectOpts = {
    host:               config.db.host,
    port:               config.db.port,
    user:               config.db.user,
    password:           config.db.password,
    database:           config.db.database,
    multipleStatements: true,
  };

  const maxAttempts = parseInt(process.env['DB_CONNECT_RETRIES'] ?? '30', 10);
  const delayMs     = parseInt(process.env['DB_CONNECT_DELAY_MS'] ?? '2000', 10);

  let conn: mysql.Connection | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      conn = await mysql.createConnection(connectOpts);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      const retryable = ['EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH'].includes(code);
      if (!retryable || attempt === maxAttempts) {
        logger.fatal(
          { err, host: config.db.host, attempt, maxAttempts },
          'Could not connect to MySQL — ensure the mysql service is running on the same Docker network (docker-compose.dev.yml)',
        );
        throw err;
      }
      logger.warn(
        { attempt, maxAttempts, code, host: config.db.host },
        'MySQL not reachable yet — retrying connection',
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  if (!conn) throw new Error('MySQL connection failed');

  const LOCK_NAME = 'lilg_migrations';
  const LOCK_TIMEOUT_S = 120;

  const [lockRows] = await conn.query<mysql.RowDataPacket[]>(
    'SELECT GET_LOCK(?, ?) AS got',
    [LOCK_NAME, LOCK_TIMEOUT_S],
  );
  if (Number(lockRows[0]?.['got']) !== 1) {
    throw new Error(`Could not acquire migration lock '${LOCK_NAME}' within ${LOCK_TIMEOUT_S}s`);
  }

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

    let appliedCount = 0;
    let skippedCount = 0;
    for (const m of migrations) {
      const existingChecksum = applied.get(m.name);
      if (existingChecksum !== undefined) {
        skippedCount++;
        if (existingChecksum !== m.checksum) {
          logger.warn({ name: m.name }, 'Migration file changed after apply (checksum mismatch); skipping');
        } else {
          logger.debug({ name: m.name }, 'Migration already applied — skipping');
        }
        continue;
      }

      const start = Date.now();
      logger.info({ name: m.name }, 'Applying migration');
      try {
        await applyMigrationSql(conn, m);
        const duration = Date.now() - start;
        await conn.query(
          `INSERT INTO ${MIGRATIONS_TABLE} (name, checksum, duration_ms) VALUES (?, ?, ?)`,
          [m.name, m.checksum, duration],
        );
        logger.info({ name: m.name, durationMs: duration }, 'Migration applied');
        appliedCount++;
      } catch (err) {
        logger.error({ name: m.name, err }, 'Migration failed — aborting startup');
        throw err;
      }
    }

    if (appliedCount === 0) {
      logger.info(
        { total: migrations.length, skipped: skippedCount },
        'Schema is up to date — all migrations already applied',
      );
    } else {
      logger.info(
        { applied: appliedCount, skipped: skippedCount, total: migrations.length },
        'Migrations applied (already-applied files were skipped)',
      );
    }
  } finally {
    await conn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
    await conn.end();
  }
}
