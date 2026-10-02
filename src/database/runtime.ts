import { createPool } from 'mysql2/promise';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { connectionOptions } from './config.js';

export class RuntimeDatabase {
  constructor(readonly pool: Pool) {}
  async connection<T>(work: (db: PoolConnection) => Promise<T>): Promise<T> {
    const db = await this.pool.getConnection();
    try {
      await db.query("SET SESSION time_zone = '+00:00'");
      return await work(db);
    } finally {
      db.release();
    }
  }
  async transaction<T>(work: (db: PoolConnection) => Promise<T>): Promise<T> {
    return this.connection(async (db) => {
      await db.beginTransaction();
      try {
        const result = await work(db);
        await db.commit();
        return result;
      } catch (error) {
        await db.rollback();
        throw error;
      }
    });
  }
  async rows<T extends RowDataPacket>(
    sql: string,
    values: (string | Buffer | number | null)[] = [],
  ): Promise<T[]> {
    return this.connection(async (db) => (await db.execute<T[]>(sql, values))[0]);
  }
}
export async function openRuntime(env: NodeJS.ProcessEnv): Promise<RuntimeDatabase> {
  // Runtime credentials are deliberately separate; no startup migration or DDL.
  const options = await connectionOptions({
    ...env,
    DB_USER: env.APP_DB_USER,
    DB_PASSWORD: env.APP_DB_PASSWORD,
  });
  const pool = createPool({ ...options, connectionLimit: 10, queueLimit: 100 });
  const database = new RuntimeDatabase(pool);
  const rows = await database.rows<RowDataPacket>(
    'SELECT VERSION() AS version, @@SESSION.sql_mode AS mode',
  );
  if (
    typeof rows[0]?.['version'] !== 'string' ||
    !rows[0]['version'].startsWith('8.4.') ||
    typeof rows[0]['mode'] !== 'string' ||
    !rows[0]['mode'].includes('STRICT_TRANS_TABLES')
  ) {
    await pool.end();
    throw new Error('Runtime requires MySQL 8.4 and strict SQL mode.');
  }
  return database;
}
