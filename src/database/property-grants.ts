import type { Connection } from 'mysql2/promise';
export async function grantPropertyRuntime(
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
    throw new Error('Invalid property grant target.');
  for (const table of [
    'society_person_references',
    'society_import_batches',
    'society_import_rows',
  ])
    await db.query('GRANT SELECT,INSERT ON ' + schema + '.' + table + ' TO ?@?', [user, host]);
  await db.query('GRANT UPDATE(code,name,archived_at) ON ' + schema + '.buildings TO ?@?', [
    user,
    host,
  ]);
  await db.query(
    'GRANT UPDATE(building_id,flat_number,area_sq_ft,archived_at) ON ' + schema + '.flats TO ?@?',
    [user, host],
  );
  await db.query(
    'GRANT UPDATE(display_name,contact_email,contact_phone,archived_at) ON ' +
      schema +
      '.society_persons TO ?@?',
    [user, host],
  );
  await db.query('GRANT UPDATE(ends_on) ON ' + schema + '.flat_occupancies TO ?@?', [user, host]);
  await db.query(
    'GRANT UPDATE(status,validation_hash,error_rows,warning_rows,confirmed_at,result_summary) ON ' +
      schema +
      '.society_import_batches TO ?@?',
    [user, host],
  );
  await db.query(
    'GRANT UPDATE(row_data,validation_errors,validation_warnings) ON ' +
      schema +
      '.society_import_rows TO ?@?',
    [user, host],
  );
}
