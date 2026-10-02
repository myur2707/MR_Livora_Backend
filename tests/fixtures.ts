import { randomBytes } from 'node:crypto';
import type { Connection, ResultSetHeader } from 'mysql2/promise';

export interface SocietyFixture {
  society: number;
  person: number;
  membership: number;
  role: number;
  building: number;
  flat: number;
  configuration: number;
  period: number;
  bill: number;
  payment: number;
}

export type SqlValue = string | number | null | Buffer;

export async function insert(
  db: Connection,
  sql: string,
  values: SqlValue[] = [],
): Promise<number> {
  const [result] = await db.execute<ResultSetHeader>(sql, values);
  return result.insertId;
}

export async function createFixture(
  db: Connection,
  code: string,
  user: number,
  person: number,
  roleCode: string,
): Promise<SocietyFixture> {
  const society = await insert(db, 'INSERT INTO societies (code, name) VALUES (?, ?)', [
    code,
    code,
  ]);
  await insert(
    db,
    'INSERT INTO society_persons (society_id, person_id, display_name) VALUES (?, ?, ?)',
    [society, person, 'Synthetic resident'],
  );
  const membership = await insert(
    db,
    "INSERT INTO society_memberships (society_id, user_id, status, joined_at) VALUES (?, ?, 'ACTIVE', CURRENT_TIMESTAMP(6))",
    [society, user],
  );
  const role = await insert(db, 'INSERT INTO roles (society_id, code, name) VALUES (?, ?, ?)', [
    society,
    roleCode,
    roleCode,
  ]);
  await insert(
    db,
    'INSERT INTO membership_roles (society_id, membership_id, role_id) VALUES (?, ?, ?)',
    [society, membership, role],
  );
  const building = await insert(
    db,
    "INSERT INTO buildings (society_id, code, name) VALUES (?, 'A', 'Block A')",
    [society],
  );
  const flat = await insert(
    db,
    "INSERT INTO flats (society_id, building_id, flat_number) VALUES (?, ?, '101')",
    [society, building],
  );
  const chargeType = await insert(
    db,
    "INSERT INTO maintenance_charge_types (society_id, code, name) VALUES (?, 'MAINTENANCE', 'Maintenance')",
    [society],
  );
  const configuration = await insert(
    db,
    "INSERT INTO maintenance_charge_configurations (society_id, charge_type_id, rate, effective_from, version) VALUES (?, ?, 100.25, '2026-01-01', 1)",
    [society, chargeType],
  );
  const period = await insert(
    db,
    "INSERT INTO billing_periods (society_id, code, starts_on, ends_on, due_on) VALUES (?, '2026-10', '2026-10-01', '2026-10-31', '2026-10-10')",
    [society],
  );
  const bill = await insert(
    db,
    "INSERT INTO bills (society_id, billing_period_id, flat_id, bill_number, total_amount) VALUES (?, ?, ?, 'B-001', 100.25)",
    [society, period, flat],
  );
  await insert(
    db,
    "INSERT INTO bill_items (society_id, bill_id, charge_configuration_id, line_number, description, quantity, unit_rate, amount) VALUES (?, ?, ?, 1, 'Maintenance snapshot', 1, 100.25, 100.25)",
    [society, bill, configuration],
  );
  await db.execute(
    "UPDATE bills SET status = 'ISSUED', issued_at = CURRENT_TIMESTAMP(6), issued_by_membership_id = ? WHERE society_id = ? AND id = ?",
    [membership, society, bill],
  );
  const payment = await insert(
    db,
    "INSERT INTO payments (society_id, flat_id, payer_person_id, method, payment_date, amount, reference, collected_by_membership_id, recorded_by_membership_id, idempotency_key) VALUES (?, ?, ?, 'CASH', '2026-10-02', 100.25, 'Synthetic reference', ?, ?, 'fixture-payment-1')",
    [society, flat, person, membership, membership],
  );
  await insert(
    db,
    'INSERT INTO payment_allocations (society_id, payment_id, bill_id, flat_id, amount) VALUES (?, ?, ?, ?, 100.25)',
    [society, payment, bill, flat],
  );
  await insert(
    db,
    "INSERT INTO receipts (society_id, payment_id, receipt_number, issued_at, issued_by_membership_id) VALUES (?, ?, 'R-001', CURRENT_TIMESTAMP(6), ?)",
    [society, payment, membership],
  );
  await insert(
    db,
    "INSERT INTO audit_logs (society_id, actor_user_id, action, entity_type, entity_id, request_id) VALUES (?, ?, 'fixture.created', 'payment', ?, ?)",
    [society, user, payment, randomBytes(16).toString('hex')],
  );
  return {
    society,
    person,
    membership,
    role,
    building,
    flat,
    configuration,
    period,
    bill,
    payment,
  };
}
