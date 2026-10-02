import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertTestTarget, connectionOptions } from '../src/database/config.js';
import { loadMigrations, parseMigration, pendingMigrations } from '../src/database/migrations.js';

const sql = 'CREATE TABLE example (id INT PRIMARY KEY) ENGINE=InnoDB;\n';

void test('baseline contains ordered, additive, independently executable migrations', async () => {
  const migrations = await loadMigrations();
  assert.equal(migrations.length, 8);
  assert.equal(migrations.slice(0, 5).flatMap((migration) => migration.statements).length, 44);
  assert.equal(migrations[5]?.statements.length, 7);
  assert.equal(migrations[6]?.statements.length, 1);
  assert.equal(migrations[7]?.statements.length, 8);
  assert.equal(new Set(migrations.map((migration) => migration.checksum)).size, 8);
});

void test('checksum is stable across Windows and Unix line endings', () => {
  assert.equal(
    parseMigration('001_example.sql', sql).checksum,
    parseMigration('001_example.sql', sql.replaceAll('\n', '\r\n')).checksum,
  );
  assert.notEqual(
    parseMigration('001_example.sql', sql).checksum,
    parseMigration('001_example.sql', sql.replace('INT', 'BIGINT')).checksum,
  );
});

void test('unsafe SQL, missing boundaries and drift-hiding clauses are rejected', () => {
  for (const unsafe of [
    'DROP TABLE example;',
    'TRUNCATE TABLE example;',
    'DELETE FROM example;',
    'SET FOREIGN_KEY_CHECKS=0;',
    'CREATE TABLE IF NOT EXISTS example (id INT);',
    'CREATE TABLE example (id INT); DROP TABLE users;',
    'CREATE TABLE a (id INT); CREATE TABLE b (id INT);',
    'CREATE TABLE a (id INT REFERENCES users(id) ON DELETE CASCADE);',
  ])
    assert.throws(() => parseMigration('001_example.sql', unsafe));
});

void test('invalid filenames, empty migration sets and sequence gaps fail', async () => {
  assert.throws(() => parseMigration('example.sql', sql));
  const directory = await mkdtemp(join(tmpdir(), 'livora-migration-test-'));
  try {
    await assert.rejects(loadMigrations(directory), /No migration files/);
    await writeFile(join(directory, '002_example.sql'), sql);
    await assert.rejects(loadMigrations(directory), /contiguous/);
  } finally {
    await rm(directory, { recursive: true });
  }
});

void test('history cannot silently skip, rename or modify applied migrations', () => {
  const migration = parseMigration('001_example.sql', sql);
  const entry = { ...migration, status: 'APPLIED' };
  assert.deepEqual(pendingMigrations([migration], []), [migration]);
  assert.deepEqual(pendingMigrations([migration], [entry]), []);
  assert.throws(() => pendingMigrations([migration], [{ ...entry, checksum: 'bad' }]), /checksum/);
  assert.throws(() => pendingMigrations([migration], [{ ...entry, status: 'STARTED' }]), /Partial/);
  assert.throws(
    () => pendingMigrations([migration], [{ ...entry, name: '001_renamed.sql' }]),
    /history/,
  );
  assert.throws(() => pendingMigrations([], [entry]), /history/);
});

void test('integration tests reject unsafe environment targets before connecting', () => {
  assertTestTarget({ NODE_ENV: 'test', DB_NAME: 'livora_test_empty', DB_HOST: '127.0.0.1' });
  for (const env of [
    { NODE_ENV: 'production', DB_NAME: 'livora_test_empty' },
    { NODE_ENV: 'test', DB_NAME: 'livora_dev' },
    { NODE_ENV: 'test', DB_NAME: 'livora_test_empty', DB_HOST: 'remote.example' },
  ])
    assert.throws(() => assertTestTarget(env));
});

void test('connection configuration enforces least privilege, TLS and safe numeric handling', async () => {
  const env = { DB_NAME: 'livora_dev', DB_USER: 'livora_migrator', DB_PASSWORD: 'fixture-only' };
  const options = await connectionOptions(env);
  assert.equal(options.multipleStatements, false);
  assert.equal(options.decimalNumbers, false);
  assert.equal(options.bigNumberStrings, true);
  assert.equal(options.timezone, 'Z');
  await assert.rejects(connectionOptions({ ...env, DB_USER: 'root' }), /dedicated/);
  await assert.rejects(connectionOptions({ ...env, DB_PASSWORD: 'replace_with_local_password' }));
  await assert.rejects(connectionOptions({ ...env, DB_NAME: 'unsafe;DROP' }));
  await assert.rejects(connectionOptions({ ...env, DB_HOST: 'remote.example' }), /CA_FILE/);
  await assert.rejects(connectionOptions({ ...env, DB_PORT: '3306x' }));
});
