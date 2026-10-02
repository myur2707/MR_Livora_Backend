import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { hashPassword } from './crypto.js';
import { permissions, roleCapabilities } from './types.js';
import { openDatabase } from '../database/runner.js';

if (existsSync('.env')) loadEnvFile('.env');
try {
  if (
    process.env.NODE_ENV !== 'development' ||
    !/^livora_dev_[a-z0-9_]+$/.test(process.env.DB_NAME ?? '') ||
    !['127.0.0.1', 'localhost', '::1'].includes(process.env.DB_HOST ?? '127.0.0.1')
  ) {
    throw new Error('Development seed requires an isolated loopback livora_dev_* schema.');
  }
  const password = z.string().min(15).max(128).parse(process.env['DEV_AUTH_PASSWORD']);
  if (password.startsWith('replace_with_'))
    throw new Error('Choose a unique development password.');
  const db = await openDatabase();
  try {
    const [existing] = await db.execute<RowDataPacket[]>(
      "SELECT id FROM users WHERE email_normalized = 'developer@example.invalid'",
    );
    if (existing.length) throw new Error('Development account already exists; no overwrite.');
    const encoded = await hashPassword(password);
    await db.beginTransaction();
    try {
      const [person] = await db.execute<ResultSetHeader>('INSERT INTO persons () VALUES ()');
      if (!Number.isSafeInteger(person.insertId)) throw new Error('Unsafe development identifier.');
      await db.execute(
        "INSERT INTO users (person_id, email_normalized, password_hash, status) VALUES (?, 'developer@example.invalid', ?, 'ACTIVE')",
        [String(person.insertId), encoded],
      );
      const [userRows] = await db.execute<RowDataPacket[]>(
        "SELECT id FROM users WHERE email_normalized = 'developer@example.invalid'",
      );
      const user: unknown = userRows[0]?.['id'];
      if (typeof user !== 'string') throw new Error('Missing development user.');
      // This explicit, isolated command grants platform access; ordinary login never creates grants.
      await db.execute(
        "INSERT INTO platform_user_roles (user_id, role_code) VALUES (?, 'PLATFORM_ADMIN')",
        [user],
      );
      await db.execute(
        "INSERT INTO societies (code, name, status) VALUES ('DEV_COMMUNITY', 'Development community', 'ACTIVE')",
      );
      const [societies] = await db.execute<RowDataPacket[]>(
        "SELECT id FROM societies WHERE code = 'DEV_COMMUNITY'",
      );
      const society: unknown = societies[0]?.['id'];
      if (typeof society !== 'string') throw new Error('Missing development society.');
      await db.execute(
        "INSERT INTO society_persons (society_id, person_id, display_name) VALUES (?, ?, 'Development resident')",
        [society, String(person.insertId)],
      );
      await db.execute(
        "INSERT INTO society_memberships (society_id, user_id, status, joined_at) VALUES (?, ?, 'ACTIVE', UTC_TIMESTAMP(6))",
        [society, user],
      );
      const [role] = await db.execute<ResultSetHeader>(
        "INSERT INTO roles (society_id, code, name) VALUES (?, 'COMMITTEE_ADMIN', 'Committee administrator')",
        [society],
      );
      if (!Number.isSafeInteger(role.insertId)) throw new Error('Unsafe development identifier.');
      await db.execute(
        'INSERT INTO membership_roles (society_id, membership_id, role_id) SELECT society_id, id, ? FROM society_memberships WHERE society_id = ? AND user_id = ?',
        [String(role.insertId), society, user],
      );
      for (const code of permissions) {
        await db.execute(
          'INSERT INTO permissions (code, description) VALUES (?, ?) ON DUPLICATE KEY UPDATE code = VALUES(code)',
          [code, code],
        );
        if (roleCapabilities.COMMITTEE_ADMIN.includes(code))
          await db.execute(
            'INSERT INTO role_permissions (society_id, role_id, permission_id) SELECT ?, ?, id FROM permissions WHERE code = ?',
            [society, String(role.insertId), code],
          );
      }
      await db.commit();
      console.info(
        'Created developer@example.invalid with the supplied local password. No credentials are printed.',
      );
    } catch (error) {
      await db.rollback();
      throw error;
    }
  } finally {
    await db.end();
  }
} catch {
  console.error('Development seed refused or failed. See docs/security/AUTHENTICATION.md.');
  process.exitCode = 1;
}
