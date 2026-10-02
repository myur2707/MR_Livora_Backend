import { readFile } from 'node:fs/promises';
import type { ConnectionOptions } from 'mysql2/promise';

export class MigrationError extends Error {}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value || value.startsWith('replace_with_')) {
    throw new MigrationError(`Set ${key} using local environment configuration.`);
  }
  return value;
}

function integer(value: string, key: string, max: number): number {
  if (!/^\d+$/.test(value)) throw new MigrationError(`${key} must be an integer.`);
  const parsed = Number(value);
  if (parsed < 1 || parsed > max) throw new MigrationError(`${key} is outside its valid range.`);
  return parsed;
}

export function assertTestTarget(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== 'test' || !/^livora_test_[a-z0-9_]+$/.test(env.DB_NAME ?? '')) {
    throw new MigrationError('DB tests require NODE_ENV=test and a livora_test_* schema.');
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(env.DB_HOST ?? '127.0.0.1')) {
    throw new MigrationError('DB integration tests are restricted to loopback.');
  }
}

export async function connectionOptions(env: NodeJS.ProcessEnv): Promise<ConnectionOptions> {
  const database = required(env, 'DB_NAME');
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(database)) {
    throw new MigrationError('DB_NAME must be a lowercase SQL identifier.');
  }
  const user = required(env, 'DB_USER');
  if (user.toLowerCase() === 'root') throw new MigrationError('Use a dedicated migration DB user.');
  const host = env.DB_HOST ?? '127.0.0.1';
  const caFile = env.DB_TLS_CA_FILE;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !caFile) {
    throw new MigrationError('Remote DB connections require DB_TLS_CA_FILE.');
  }
  return {
    host,
    database,
    user,
    password: required(env, 'DB_PASSWORD'),
    port: integer(env.DB_PORT ?? '3306', 'DB_PORT', 65535),
    connectTimeout: integer(env.DB_CONNECT_TIMEOUT_MS ?? '10000', 'DB_CONNECT_TIMEOUT_MS', 60000),
    charset: 'utf8mb4',
    timezone: 'Z',
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    multipleStatements: false,
    ...(caFile ? { ssl: { ca: await readFile(caFile, 'utf8'), rejectUnauthorized: true } } : {}),
  };
}
