import type { Connection } from 'mysql2/promise';
export async function grantResidentAccessRuntime(
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
    throw new Error('Invalid resident access grant target.');
  for (const table of [
    'invitations',
    'resident_invitation_details',
    'registration_requests',
    'registration_request_details',
    'resident_account_verifications',
    'membership_person_links',
  ])
    await db.query('GRANT SELECT,INSERT ON ' + schema + '.' + table + ' TO ?@?', [user, host]);
  await db.query('GRANT INSERT ON ' + schema + '.resident_account_events TO ?@?', [user, host]);
  for (const [table, columns] of [
    ['invitations', 'status,accepted_at,accepted_by_user_id'],
    ['resident_invitation_details', 'delivery_status,accepted_membership_id'],
    ['registration_requests', 'status,reviewed_at,reviewed_by_membership_id,decision_note'],
    [
      'registration_request_details',
      'resolved_person_id,approved_membership_id,approved_occupancy_id',
    ],
    ['resident_account_verifications', 'consumed_at,email_normalized,display_name,password_hash'],
  ])
    await db.query('GRANT UPDATE(' + columns + ') ON ' + schema + '.' + table + ' TO ?@?', [
      user,
      host,
    ]);
}
