import assert from 'node:assert/strict';
import type { Connection, RowDataPacket } from 'mysql2/promise';

interface TableRow extends RowDataPacket {
  TABLE_NAME: string;
}

interface TimeRow extends RowDataPacket {
  timezone: string;
  created_at: string;
  utc_now: string;
}

// Global identity infrastructure is separate from tenant-owned business resources.
const globalTables = [
  'societies',
  'persons',
  'users',
  'permissions',
  '_schema_migrations',
  'auth_sessions',
  'password_reset_tokens',
  'platform_user_roles',
  'auth_rate_limits',
  'auth_events',
];
const placeholders = globalTables.map(() => '?').join(', ');
const tenantPredicate = `t.TABLE_SCHEMA = DATABASE()
  AND t.TABLE_TYPE = 'BASE TABLE' AND t.TABLE_NAME NOT IN (${placeholders})`;

async function assertNoViolations(db: Connection, sql: string, message: string): Promise<void> {
  const [rows] = await db.execute<TableRow[]>(sql, globalTables);
  assert.deepEqual(
    rows.map((row) => row.TABLE_NAME),
    [],
    message,
  );
}

export async function assertTenantSchema(db: Connection): Promise<void> {
  await assertNoViolations(
    db,
    `SELECT t.TABLE_NAME FROM information_schema.TABLES t
     WHERE ${tenantPredicate} AND NOT EXISTS (
       SELECT 1 FROM information_schema.COLUMNS c
       WHERE c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
         AND c.COLUMN_NAME = 'society_id' AND c.IS_NULLABLE = 'NO'
         AND c.COLUMN_TYPE = 'bigint unsigned'
     )`,
    'Every tenant table requires a non-null unsigned society_id',
  );
  await assertNoViolations(
    db,
    `SELECT t.TABLE_NAME FROM information_schema.TABLES t
     WHERE ${tenantPredicate} AND NOT EXISTS (
       SELECT 1 FROM information_schema.KEY_COLUMN_USAGE k
       WHERE k.TABLE_SCHEMA = t.TABLE_SCHEMA AND k.TABLE_NAME = t.TABLE_NAME
         AND k.COLUMN_NAME = 'society_id' AND k.REFERENCED_TABLE_NAME = 'societies'
         AND k.REFERENCED_COLUMN_NAME = 'id'
     )`,
    'Every tenant table must reference the society directory',
  );
  await assertNoViolations(
    db,
    `SELECT t.TABLE_NAME FROM information_schema.TABLES t
     WHERE ${tenantPredicate} AND NOT EXISTS (
       SELECT 1 FROM information_schema.STATISTICS s
       WHERE s.TABLE_SCHEMA = t.TABLE_SCHEMA AND s.TABLE_NAME = t.TABLE_NAME
         AND s.NON_UNIQUE = 0
       GROUP BY s.INDEX_NAME
       HAVING GROUP_CONCAT(s.COLUMN_NAME ORDER BY s.SEQ_IN_INDEX) = 'society_id,id'
     )`,
    'Every tenant resource requires a unique composite society/resource key',
  );
  await assertNoViolations(
    db,
    `SELECT k.TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE k
     WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL
       AND k.REFERENCED_TABLE_NAME NOT IN (${placeholders}) AND NOT EXISTS (
         SELECT 1 FROM information_schema.KEY_COLUMN_USAGE scope
         WHERE scope.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
           AND scope.TABLE_NAME = k.TABLE_NAME AND scope.CONSTRAINT_NAME = k.CONSTRAINT_NAME
           AND scope.COLUMN_NAME = 'society_id' AND scope.REFERENCED_COLUMN_NAME = 'society_id'
       )`,
    'Every relationship to a tenant resource must include the tenant key',
  );
}

export async function assertUtcTimestamps(db: Connection, person: number): Promise<void> {
  const [rows] = await db.execute<TimeRow[]>(
    `SELECT @@SESSION.time_zone AS timezone, created_at, UTC_TIMESTAMP(6) AS utc_now
     FROM persons WHERE id = ?`,
    [person],
  );
  const row = rows[0];
  assert.ok(row);
  assert.equal(row.timezone, '+00:00');
  const createdAt = Date.parse(row.created_at.replace(' ', 'T') + 'Z');
  const utcNow = Date.parse(row.utc_now.replace(' ', 'T') + 'Z');
  assert.ok(Number.isFinite(createdAt) && Number.isFinite(utcNow));
  assert.ok(utcNow >= createdAt && utcNow - createdAt < 60000, 'Stored creation time must be UTC');
}
