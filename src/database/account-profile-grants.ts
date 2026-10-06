import type { Connection } from 'mysql2/promise';

export async function grantAccountProfileRuntime(
  db: Connection,
  schema: string,
  user: string,
  host: string,
): Promise<void> {
  if (
    !/^[a-z][a-z0-9_]+$/.test(schema) ||
    !/^[a-z][a-z0-9_]+$/.test(user) ||
    user === 'root' ||
    !['127.0.0.1', '%'].includes(host)
  )
    throw new Error('Invalid account profile grant target.');
  await db.query('GRANT SELECT,INSERT,UPDATE ON ' + schema + '.account_profiles TO ?@?', [
    user,
    host,
  ]);
  await db.query('GRANT INSERT ON ' + schema + '.account_profile_events TO ?@?', [user, host]);
}
