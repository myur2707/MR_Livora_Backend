import { loadEnvFile } from 'node:process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createConnection } from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { openDatabase, migrate } from './runner.js';
import { loadMigrations } from './migrations.js';
import { grantPropertyRuntime } from './property-grants.js';
import { grantResidentAccessRuntime } from './resident-access-grants.js';
import { grantOnboardingRuntime } from './onboarding-grants.js';
import { grantBillingRuntime, provisionBillingPermissions } from './billing-grants.js';
import { grantResidentPortalRuntime } from './resident-portal-grants.js';
import { grantCommunityRuntime, provisionCommunityPermissions } from './community-grants.js';
import { provisionReportPermissions } from './report-permissions.js';
async function upgrade(): Promise<void> {
  const dataRoot = resolve('.local-db/manual');
  const settings = z
    .object({
      dataRoot: z.string(),
      dbPort: z.literal(3307),
      adminPassword: z.string().regex(/^[a-f0-9]{64}$/),
      provisioned: z.literal(true),
    })
    .parse(JSON.parse(await readFile(resolve(dataRoot, 'settings.json'), 'utf8')));
  loadEnvFile('.env');
  if (
    process.env.NODE_ENV !== 'development' ||
    resolve(settings.dataRoot) !== dataRoot ||
    process.env.DB_HOST !== '127.0.0.1' ||
    process.env.DB_PORT !== '3307' ||
    process.env.DB_NAME !== 'livora_dev_manual' ||
    process.env.APP_DB_USER !== 'livora_manual_app'
  )
    throw new Error('Unexpected managed development target.');
  const admin = await createConnection({
    host: '127.0.0.1',
    port: settings.dbPort,
    user: 'root',
    password: settings.adminPassword,
  });
  try {
    const [rows] = await admin.query<RowDataPacket[]>('SELECT @@datadir AS directory');
    const directory: unknown = rows[0]?.['directory'];
    if (typeof directory !== 'string' || resolve(directory) !== resolve(dataRoot, 'data'))
      throw new Error('Unexpected MySQL instance.');
    const db = await openDatabase();
    try {
      console.info(
        'Applied ' +
          (await migrate(db, await loadMigrations(), 'livora_dev_manual')) +
          ' additive local migrations.',
      );
      await provisionBillingPermissions(db);
      await provisionCommunityPermissions(db);
      await provisionReportPermissions(db);
    } finally {
      await db.end();
    }
    await grantOnboardingRuntime(admin, 'livora_dev_manual', 'livora_manual_app', '127.0.0.1');
    await grantPropertyRuntime(admin, 'livora_dev_manual', 'livora_manual_app', '127.0.0.1');
    await grantResidentAccessRuntime(admin, 'livora_dev_manual', 'livora_manual_app', '127.0.0.1');
    await grantBillingRuntime(admin, 'livora_dev_manual', 'livora_manual_app', '127.0.0.1');
    await grantResidentPortalRuntime(admin, 'livora_dev_manual', 'livora_manual_app', '127.0.0.1');
    await grantCommunityRuntime(admin, 'livora_dev_manual', 'livora_manual_app', '127.0.0.1');
    console.info('Managed local runtime grants updated; existing data and accounts retained.');
  } finally {
    await admin.end();
  }
}
upgrade().catch(() => {
  console.error(
    'Local additive upgrade refused or failed; inspect migration status. No automatic cleanup.',
  );
  process.exitCode = 1;
});
