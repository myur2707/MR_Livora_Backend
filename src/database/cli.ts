import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { MigrationError } from './config.js';
import { loadMigrations, pendingMigrations } from './migrations.js';
import { migrate, openDatabase, readHistory } from './runner.js';
import { provisionBillingPermissions } from './billing-grants.js';

async function main(): Promise<void> {
  if (existsSync('.env')) loadEnvFile('.env');
  const command = process.argv[2];
  if (!['validate', 'status', 'migrate', 'billing-permissions'].includes(command ?? '')) {
    throw new MigrationError('Usage: database/cli.ts validate|status|migrate|billing-permissions');
  }
  const migrations = await loadMigrations();
  if (command === 'validate') {
    console.info(`Validated ${migrations.length} additive migrations (no database connection).`);
    return;
  }
  const db = await openDatabase();
  try {
    if (command === 'billing-permissions') {
      if (pendingMigrations(migrations, await readHistory(db)).length)
        throw new MigrationError('Apply all migrations before provisioning billing permissions.');
      await provisionBillingPermissions(db);
      console.info('Additive billing permissions provisioned; existing restrictions retained.');
    } else if (command === 'status') {
      const history = await readHistory(db);
      const pending = pendingMigrations(migrations, history);
      console.info(`${history.length} applied; ${pending.length} pending migrations.`);
    } else {
      console.info(
        `Applied ${await migrate(db, migrations, process.env.DB_NAME ?? '')} migrations.`,
      );
    }
  } finally {
    await db.end();
  }
}

main().catch((error: unknown) => {
  // The CLI intentionally omits raw driver messages, which can contain SQL and credentials.
  console.error(
    error instanceof MigrationError
      ? error.message
      : 'Database operation failed. Inspect server logs and migration status; no automatic rollback occurred.',
  );
  process.exitCode = 1;
});
