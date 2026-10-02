import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MigrationError } from './config.js';

export interface Migration {
  version: number;
  name: string;
  checksum: string;
  statements: string[];
}

export interface MigrationHistory {
  version: number;
  name: string;
  checksum: string;
  status: string;
}

const boundary = /^-- statement-breakpoint\s*$/m;

export function parseMigration(name: string, contents: string): Migration {
  const match = /^(\d{3})_([a-z0-9_]+)\.sql$/.exec(name);
  if (!match?.[1]) throw new MigrationError(`Invalid migration filename: ${name}`);
  const normalized = contents.replace(/\r\n?/g, '\n').trimEnd() + '\n';
  const statements = normalized.split(boundary).map((statement) => statement.trim());
  for (const statement of statements) {
    const sql = statement.replace(/^\s*--[^\n]*(?:\n|$)/gm, '').trim();
    if (!/^CREATE (?:TABLE|TRIGGER) [a-z][a-z0-9_]*\b/i.test(sql)) {
      throw new MigrationError(
        `${name}: only additive CREATE TABLE / CREATE TRIGGER is supported.`,
      );
    }
    if (/\b(?:DROP|TRUNCATE|CASCADE|FOREIGN_KEY_CHECKS|IF NOT EXISTS)\b/i.test(sql)) {
      throw new MigrationError(`${name}: unsafe or drift-hiding SQL is not allowed.`);
    }
    if (/^CREATE TABLE/i.test(sql) && (sql.match(/;/g)?.length !== 1 || !sql.endsWith(';'))) {
      throw new MigrationError(`${name}: table statements require an explicit boundary.`);
    }
    if (/^CREATE TRIGGER/i.test(sql) && /\bCREATE\b/i.test(sql.slice(6))) {
      throw new MigrationError(`${name}: trigger statements require an explicit boundary.`);
    }
  }
  return {
    version: Number(match[1]),
    name,
    checksum: createHash('sha256').update(normalized).digest('hex'),
    statements,
  };
}

export async function loadMigrations(
  directory = resolve('database/migrations'),
): Promise<Migration[]> {
  const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  if (files.length === 0) throw new MigrationError('No migration files found.');
  const migrations: Migration[] = [];
  for (const name of files) {
    const migration = parseMigration(name, await readFile(resolve(directory, name), 'utf8'));
    if (migration.version !== migrations.length + 1) {
      throw new MigrationError('Migration versions must be contiguous, starting at 001.');
    }
    migrations.push(migration);
  }
  return migrations;
}

export function pendingMigrations(
  migrations: Migration[],
  history: MigrationHistory[],
): Migration[] {
  history.forEach((entry, index) => {
    const file = migrations[index];
    if (!file || entry.version !== file.version || entry.name !== file.name) {
      throw new MigrationError('Migration history differs from this checkout.');
    }
    if (entry.checksum !== file.checksum) {
      throw new MigrationError('Applied migration checksum differs; restore the original file.');
    }
    if (entry.status !== 'APPLIED') {
      throw new MigrationError('Partial migration detected. Inspect DDL before operator recovery.');
    }
  });
  return migrations.slice(history.length);
}
