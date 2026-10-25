import type { Connection } from 'mysql2/promise';

/** Runtime access to the committee-published applicant contact; no delete, audited by the app. */
export async function grantSocietyContactRuntime(
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
    throw new Error('Invalid society contact grant target.');
  await db.query('GRANT SELECT,INSERT ON ' + schema + '.society_contacts TO ?@?', [user, host]);
  await db.query(
    'GRANT UPDATE(contact_phone,contact_email,updated_by_membership_id) ON ' +
      schema +
      '.society_contacts TO ?@?',
    [user, host],
  );
}
