import { createConnection } from 'mysql2/promise';

if (process.env.NODE_ENV !== 'test' || process.env.DB_NAME !== 'livora_test_ci') {
  throw new Error('This provisioning helper is restricted to the isolated CI database.');
}
const db = await createConnection({
  host: '127.0.0.1',
  user: 'root',
  password: process.env.DB_TEST_ADMIN_PASSWORD,
});
try {
  // Trigger DDL needs a DBA-reviewed binary logging policy. This service holds only CI fixtures.
  await db.query('SET GLOBAL log_bin_trust_function_creators = 1');
} finally {
  await db.end();
}
