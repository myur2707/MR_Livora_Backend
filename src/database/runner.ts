import { createHash } from 'node:crypto';
import { createConnection } from 'mysql2/promise';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { connectionOptions, MigrationError } from './config.js';
import { pendingMigrations } from './migrations.js';
import type { Migration, MigrationHistory } from './migrations.js';

interface HistoryRow extends RowDataPacket, MigrationHistory {}
interface TableRow extends RowDataPacket {
  TABLE_NAME: string;
}
interface ServerRow extends RowDataPacket {
  version: string;
  mode: string;
}
interface LockRow extends RowDataPacket {
  acquired: number | string | null;
}

const metadataSql = `CREATE TABLE _schema_migrations (
  version INT UNSIGNED NOT NULL PRIMARY KEY,
  name VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  checksum CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  started_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  applied_at DATETIME(6) NULL,
  CHECK (status IN ('STARTED', 'APPLIED'))
) ENGINE=InnoDB`;

export async function openDatabase(env = process.env): Promise<Connection> {
  const db = await createConnection(await connectionOptions(env));
  try {
    await db.query("SET SESSION time_zone = '+00:00'");
    const [rows] = await db.query<ServerRow[]>(
      'SELECT VERSION() AS version, @@SESSION.sql_mode AS mode',
    );
    const server = rows[0];
    if (
      !server ||
      !/^8\.4\./.test(server.version) ||
      !server.mode.includes('STRICT_TRANS_TABLES')
    ) {
      throw new MigrationError('Use MySQL 8.4 LTS with STRICT_TRANS_TABLES enabled.');
    }
    return db;
  } catch (error) {
    await db.end();
    throw error;
  }
}

export async function schemaTables(db: Connection): Promise<string[]> {
  const [rows] = await db.execute<TableRow[]>(
    'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()',
  );
  return rows.map((row) => row.TABLE_NAME);
}

export async function readHistory(db: Connection): Promise<MigrationHistory[]> {
  if (!(await schemaTables(db)).includes('_schema_migrations')) return [];
  const [rows] = await db.query<HistoryRow[]>(
    'SELECT version, name, checksum, status FROM _schema_migrations ORDER BY version',
  );
  return rows.map(({ version, name, checksum, status }) => ({ version, name, checksum, status }));
}

async function applyMigration(db: Connection, migration: Migration): Promise<void> {
  await db.execute(
    'INSERT INTO _schema_migrations (version, name, checksum, status) VALUES (?, ?, ?, ?)',
    [migration.version, migration.name, migration.checksum, 'STARTED'],
  );
  for (const statement of migration.statements) await db.query(statement);
  await db.execute(
    "UPDATE _schema_migrations SET status = 'APPLIED', applied_at = CURRENT_TIMESTAMP(6) WHERE version = ? AND status = 'STARTED'",
    [migration.version],
  );
}

export async function migrate(
  db: Connection,
  migrations: Migration[],
  database: string,
): Promise<number> {
  const lock = `livora_migrate_${createHash('sha256').update(database).digest('hex').slice(0, 40)}`;
  const [rows] = await db.execute<LockRow[]>('SELECT GET_LOCK(?, 10) AS acquired', [lock]);
  if (Number(rows[0]?.acquired) !== 1)
    throw new MigrationError('Could not acquire the migration lock.');
  try {
    const tables = await schemaTables(db);
    if (!tables.includes('_schema_migrations')) {
      if (tables.length > 0)
        throw new MigrationError('Refusing to baseline an unmanaged nonempty schema.');
      await db.query(metadataSql);
    }
    const history = await readHistory(db);
    if (history.length === 0 && tables.some((table) => table !== '_schema_migrations')) {
      throw new MigrationError(
        'Empty migration history with existing tables requires operator review.',
      );
    }
    const pending = pendingMigrations(migrations, history);
    for (const migration of pending) await applyMigration(db, migration);
    return pending.length;
  } finally {
    await db.execute('SELECT RELEASE_LOCK(?)', [lock]);
  }
}
