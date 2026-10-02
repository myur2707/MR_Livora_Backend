import { createConnection } from 'mysql2/promise';
import { assertTestTarget } from '../src/database/config.js';
import { grantPropertyRuntime } from '../src/database/property-grants.js';
import { grantOnboardingRuntime } from '../src/database/onboarding-grants.js';

export async function grantTestRuntime(): Promise<void> {
  assertTestTarget(process.env);
  const schema = process.env.DB_NAME;
  const user = process.env['APP_DB_USER'];
  const password = process.env['APP_DB_PASSWORD'];
  const adminPassword = process.env['DB_TEST_ADMIN_PASSWORD'];
  if (!schema || !user || !password || !adminPassword)
    throw new Error(
      'Test runtime provisioning requires explicit disposable admin/runtime configuration.',
    );
  const db = await createConnection({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT),
    user: 'root',
    password: adminPassword,
  });
  try {
    await db.query('CREATE USER IF NOT EXISTS ?@? IDENTIFIED BY ?', [user, '%', password]);
    const readTables = [
      'users',
      'societies',
      'society_persons',
      'society_memberships',
      'roles',
      'membership_roles',
      'permissions',
      'role_permissions',
      'platform_user_roles',
    ];
    for (const table of readTables)
      await db.query(`GRANT SELECT ON \`${schema}\`.\`${table}\` TO ?@?`, [user, '%']);
    await db.query(`GRANT UPDATE (password_hash) ON \`${schema}\`.users TO ?@?`, [user, '%']);
    for (const table of ['auth_sessions', 'password_reset_tokens', 'auth_rate_limits'])
      await db.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON \`${schema}\`.\`${table}\` TO ?@?`, [
        user,
        '%',
      ]);
    await db.query(`GRANT INSERT ON \`${schema}\`.auth_events TO ?@?`, [user, '%']);
    await grantOnboardingRuntime(db, schema, user, '%');
    await grantPropertyRuntime(db, schema, user, '%');
  } finally {
    await db.end();
  }
}
