import type { Connection } from 'mysql2/promise';
export async function grantOnboardingRuntime(
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
    throw new Error('Invalid explicit onboarding grant target.');
  for (const table of [
    'persons',
    'users',
    'societies',
    'society_persons',
    'society_memberships',
    'roles',
    'membership_roles',
    'role_permissions',
    'buildings',
    'flats',
    'flat_occupancies',
    'maintenance_charge_types',
    'maintenance_charge_configurations',
  ])
    await db.query('GRANT SELECT, INSERT ON ' + schema + '.' + table + ' TO ?@?', [user, host]);
  await db.query('GRANT INSERT, UPDATE(code) ON ' + schema + '.permissions TO ?@?', [user, host]);
  await db.query('GRANT UPDATE(status) ON ' + schema + '.societies TO ?@?', [user, host]);
  await db.query(
    'GRANT UPDATE(code,name,archived_at) ON ' + schema + '.maintenance_charge_types TO ?@?',
    [user, host],
  );
  await db.query(
    'GRANT UPDATE(calculation_method,rate,effective_from) ON ' +
      schema +
      '.maintenance_charge_configurations TO ?@?',
    [user, host],
  );
  for (const table of ['society_onboarding', 'society_setup_invitations'])
    await db.query('GRANT SELECT,INSERT,UPDATE ON ' + schema + '.' + table + ' TO ?@?', [
      user,
      host,
    ]);
  for (const table of ['society_onboarding_events', 'society_onboarding_event_details'])
    await db.query('GRANT SELECT,INSERT ON ' + schema + '.' + table + ' TO ?@?', [user, host]);
  await db.query('GRANT SELECT,INSERT ON ' + schema + '.onboarding_archived_records TO ?@?', [
    user,
    host,
  ]);
  await db.query('GRANT INSERT ON ' + schema + '.audit_logs TO ?@?', [user, host]);
  // Platform audit trail reads who/what/when columns only; safe_metadata stays unreadable.
  await db.query(
    'GRANT SELECT(id,society_id,actor_user_id,action,entity_type,entity_id,request_id,created_at) ON ' +
      schema +
      '.audit_logs TO ?@?',
    [user, host],
  );
}
