import type { Connection } from 'mysql2/promise';
export const billingTables = [
  'maintenance_charge_type_details',
  'maintenance_configuration_details',
  'billing_period_details',
  'billing_generation_runs',
  'billing_bill_details',
  'billing_discount_details',
  'one_time_charge_applications',
  'payment_details',
  'payment_refunds',
  'payment_refund_allocations',
  'payment_reversal_details',
  'payment_commands',
] as const;
export async function grantBillingRuntime(
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
    throw new Error('Invalid explicit billing grant target.');
  for (const table of [
    ...billingTables,
    'billing_periods',
    'bills',
    'bill_items',
    'bill_adjustments',
    'payments',
    'payment_allocations',
    'payment_reversals',
    'receipts',
  ])
    await db.query('GRANT SELECT,INSERT ON ' + schema + '.' + table + ' TO ?@?', [user, host]);
  await db.query(
    'GRANT UPDATE(status,issued_at,issued_by_membership_id) ON ' + schema + '.bills TO ?@?',
    [user, host],
  );
  await db.query(
    'GRANT UPDATE(status,bill_count,completed_at) ON ' + schema + '.billing_generation_runs TO ?@?',
    [user, host],
  );
}
export async function provisionBillingPermissions(db: Connection): Promise<void> {
  await db.beginTransaction();
  try {
    for (const code of [
      'society.finance.configure',
      'society.finance.generate',
      'society.finance.discount',
      'society.finance.reverse',
    ]) {
      await db.execute(
        'INSERT INTO permissions(code,description) VALUES(?,?) ON DUPLICATE KEY UPDATE code=VALUES(code)',
        [code, code],
      );
      // Existing intentionally restricted roles keep their restrictions. No platform grant.
      await db.execute(
        "INSERT INTO role_permissions(society_id,role_id,permission_id) SELECT r.society_id,r.id,p.id FROM roles r JOIN permissions p ON p.code=? WHERE r.archived_at IS NULL AND (r.code='COMMITTEE_ADMIN' OR (?='society.finance.generate' AND r.code='ACCOUNTANT')) AND EXISTS(SELECT 1 FROM role_permissions rp JOIN permissions old ON old.id=rp.permission_id WHERE rp.society_id=r.society_id AND rp.role_id=r.id AND old.code='society.finance.read') AND EXISTS(SELECT 1 FROM role_permissions rp JOIN permissions old ON old.id=rp.permission_id WHERE rp.society_id=r.society_id AND rp.role_id=r.id AND old.code='society.finance.record') AND NOT EXISTS(SELECT 1 FROM role_permissions present WHERE present.society_id=r.society_id AND present.role_id=r.id AND present.permission_id=p.id)",
        [code, code],
      );
    }
    await db.commit();
  } catch (error) {
    await db.rollback();
    throw error;
  }
}
