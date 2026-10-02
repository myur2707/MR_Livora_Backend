import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createConnection } from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { openDatabase, migrate } from './runner.js';
import { loadMigrations } from './migrations.js';
import { manualAccounts, seedManualFixtures } from './manual-fixtures.js';

const settingsSchema = z.object({
  dataRoot: z.string(),
  dbPort: z.number().int().min(1024).max(65535),
  adminPassword: z.string().regex(/^[a-f0-9]{64}$/),
  provisioned: z.boolean(),
});
async function provision(): Promise<void> {
  const dataRoot = resolve('.local-db/manual');
  const settingsPath = resolve(dataRoot, 'settings.json');
  const settings = settingsSchema.parse(JSON.parse(await readFile(settingsPath, 'utf8')));
  if (
    process.env.NODE_ENV !== 'development' ||
    resolve(settings.dataRoot) !== dataRoot ||
    process.argv[2] !== 'provision' ||
    settings.provisioned
  )
    throw new Error(
      "Local provisioning requires this repository's new isolated development instance.",
    );
  const database = 'livora_dev_manual';
  const migrator = 'livora_manual_migrator';
  const appUser = 'livora_manual_app';
  const secret = () => randomBytes(32).toString('hex');
  const dbPassword = secret();
  const appPassword = secret();
  const password = secret();
  const smtpPassword = secret();
  const admin = await createConnection({ host: '127.0.0.1', port: settings.dbPort, user: 'root' });
  try {
    const [rows] = await admin.query<RowDataPacket[]>(
      'SELECT @@datadir AS directory, VERSION() AS version',
    );
    const directory: unknown = rows[0]?.['directory'];
    const version: unknown = rows[0]?.['version'];
    if (
      typeof directory !== 'string' ||
      resolve(directory) !== resolve(dataRoot, 'data') ||
      typeof version !== 'string' ||
      !/^8\.4\./.test(version)
    )
      throw new Error('Refusing to provision an unexpected MySQL instance.');
    await admin.query("ALTER USER 'root'@'localhost' IDENTIFIED BY ?", [settings.adminPassword]);
    // Only this dedicated loopback instance; trigger definers keep schema-scoped privileges.
    await admin.query('SET GLOBAL log_bin_trust_function_creators = 1');
    await admin.query(
      'CREATE DATABASE livora_dev_manual CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_ci',
    );
    await admin.query('CREATE USER ?@? IDENTIFIED BY ?', [migrator, '127.0.0.1', dbPassword]);
    await admin.query(
      'GRANT SELECT, INSERT, UPDATE, CREATE, REFERENCES, TRIGGER ON livora_dev_manual.* TO ?@?',
      [migrator, '127.0.0.1'],
    );
    await admin.query('CREATE USER ?@? IDENTIFIED BY ?', [appUser, '127.0.0.1', appPassword]);
    const env = {
      NODE_ENV: 'development',
      DB_HOST: '127.0.0.1',
      DB_PORT: String(settings.dbPort),
      DB_NAME: database,
      DB_USER: migrator,
      DB_PASSWORD: dbPassword,
      DB_TLS_CA_FILE: '',
      APP_DB_USER: appUser,
      APP_DB_PASSWORD: appPassword,
      HOST: '127.0.0.1',
      PORT: '3000',
      APP_ORIGIN: 'http://127.0.0.1:4200',
      AUTH_SECRET: secret(),
      TRUSTED_PROXY_IP: '',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '1025',
      SMTP_USER: 'livora-local',
      SMTP_PASSWORD: smtpPassword,
      SMTP_FROM: 'noreply@example.invalid',
    };
    if (existsSync('.env'))
      await copyFile('.env', resolve(dataRoot, 'previous-' + Date.now() + '.env.bak'));
    // Persist recovery credentials before additive DDL; never retry a partial setup blindly.
    await writeFile(
      '.env',
      Object.entries(env)
        .map(([key, value]) => key + '=' + value)
        .join('\n') + '\n',
      { mode: 0o600 },
    );
    await writeFile(resolve(dataRoot, 'smtp-auth.txt'), 'livora-local:' + smtpPassword + '\n', {
      mode: 0o600,
    });
    const db = await openDatabase(env);
    try {
      await migrate(db, await loadMigrations(), database);
      await seedManualFixtures(db, password);
    } finally {
      await db.end();
    }
    for (const table of [
      'users',
      'societies',
      'society_persons',
      'society_memberships',
      'roles',
      'membership_roles',
      'permissions',
      'role_permissions',
      'platform_user_roles',
    ])
      await admin.query('GRANT SELECT ON livora_dev_manual.' + table + ' TO ?@?', [
        appUser,
        '127.0.0.1',
      ]);
    await admin.query('GRANT UPDATE (password_hash) ON livora_dev_manual.users TO ?@?', [
      appUser,
      '127.0.0.1',
    ]);
    for (const table of ['auth_sessions', 'password_reset_tokens', 'auth_rate_limits'])
      await admin.query(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON livora_dev_manual.' + table + ' TO ?@?',
        [appUser, '127.0.0.1'],
      );
    await admin.query('GRANT INSERT ON livora_dev_manual.auth_events TO ?@?', [
      appUser,
      '127.0.0.1',
    ]);
    await writeFile(
      resolve(dataRoot, 'TEST_ACCOUNTS.md'),
      '# Local manual-test accounts\n\nApp: http://127.0.0.1:4200\nInbox: http://127.0.0.1:8025\n\n' +
        'Initial password for all synthetic accounts (local testing only):\n\n' +
        password +
        '\n\n' +
        manualAccounts
          .map(
            (account) =>
              '- ' +
              account.email +
              ' — ' +
              account.status +
              (account.platform ? ' / PLATFORM_ADMIN (no society membership)' : '') +
              account.memberships
                .map(
                  ([society, role]) =>
                    ' / ' + (society === 0 ? 'Green Meadows' : 'Blue Heights') + ': ' + role,
                )
                .join(''),
          )
          .join('\n') +
        '\n\nResetting a password changes that account only; this file records initial passwords. No business screens are implemented yet.\n',
      { mode: 0o600 },
    );
    await writeFile(settingsPath, JSON.stringify({ ...settings, provisioned: true }, null, 2), {
      mode: 0o600,
    });
    console.info(
      'Local database, migrations and synthetic accounts ready. Credentials are in ignored .local-db/manual/TEST_ACCOUNTS.md.',
    );
  } finally {
    await admin.end();
  }
}

provision().catch(() => {
  // Driver errors can include SQL and credentials; retain data and report a safe failure.
  console.error(
    'Local setup refused or failed. Inspect retained local configuration; no data was deleted.',
  );
  process.exitCode = 1;
});
