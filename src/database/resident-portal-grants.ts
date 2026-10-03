import type { Connection } from 'mysql2/promise';
export async function grantResidentPortalRuntime(
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
    throw new Error('Invalid explicit resident portal grant target.');
  await db.query('GRANT SELECT ON ' + schema + '.notices TO ?@?', [user, host]);
  await db.query('GRANT SELECT,INSERT ON ' + schema + '.complaints TO ?@?', [user, host]);
}
