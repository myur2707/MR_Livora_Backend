import { propertyIntegration } from './property.integration.js';
import { residentAccessIntegration } from './resident-access.integration.js';
import { billingIntegration } from './billing.integration.js';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import test from 'node:test';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { assertTestTarget } from '../src/database/config.js';
import { loadMigrations } from '../src/database/migrations.js';
import { migrate, openDatabase, readHistory, schemaTables } from '../src/database/runner.js';
import { createFixture, insert } from './fixtures.js';
import type { SqlValue } from './fixtures.js';
import { assertTenantSchema, assertUtcTimestamps } from './schema-contract.js';
import { authIntegration } from './auth.integration.js';
import { onboardingIntegration } from './onboarding.integration.js';

interface ValueRow extends RowDataPacket {
  value: string | number;
}

async function value(
  db: Connection,
  sql: string,
  values: SqlValue[] = [],
): Promise<string | number> {
  const [rows] = await db.execute<ValueRow[]>(sql, values);
  const row = rows[0];
  assert.ok(row, 'Query must return a row');
  return row.value;
}

function dbError(expected: string | number): (error: unknown) => boolean {
  return (error) =>
    typeof error === 'object' &&
    error !== null &&
    (('code' in error && error.code === expected) ||
      ('errno' in error && error.errno === expected));
}

void test('MySQL 8.4 schema and security invariants on an empty disposable schema', async (suite) => {
  if (existsSync('.env')) loadEnvFile('.env');
  assertTestTarget(process.env);
  const db = await openDatabase();
  try {
    assert.deepEqual(await schemaTables(db), [], 'Test schema must be empty; no automatic cleanup');
    const migrations = await loadMigrations();
    await suite.test('concurrent migrators serialize; rerun is a no-op', async () => {
      const other = await openDatabase();
      try {
        const applied = await Promise.all([
          migrate(db, migrations, process.env.DB_NAME ?? ''),
          migrate(other, migrations, process.env.DB_NAME ?? ''),
        ]);
        assert.equal(applied[0] + applied[1], migrations.length);
        assert.equal(await migrate(db, migrations, process.env.DB_NAME ?? ''), 0);
        assert.equal((await readHistory(db)).length, migrations.length);
      } finally {
        await other.end();
      }
    });

    assert.equal(
      (await readHistory(db)).filter((entry) => entry.status === 'APPLIED').length,
      migrations.length,
      'Do not run fixtures on a partially migrated schema',
    );

    await suite.test(
      'every tenant table and resource relationship enforces society scope',
      async () => {
        await assertTenantSchema(db);
      },
    );

    const person = await insert(db, 'INSERT INTO persons () VALUES ()');

    await suite.test('database sessions and stored creation timestamps use UTC', async () => {
      await assertUtcTimestamps(db, person);
    });

    const user = await insert(db, 'INSERT INTO users (person_id, email_normalized) VALUES (?, ?)', [
      person,
      'synthetic@example.invalid',
    ]);
    const a = await createFixture(db, 'TEST_A', user, person, 'COMMITTEE_ADMIN');
    const b = await createFixture(db, 'TEST_B', user, person, 'RESIDENT');
    const noLoginPerson = await insert(db, 'INSERT INTO persons () VALUES ()');
    await insert(
      db,
      'INSERT INTO society_persons (society_id, person_id, display_name) VALUES (?, ?, ?)',
      [a.society, noLoginPerson, 'Synthetic no-login resident'],
    );

    await suite.test(
      'Person can exist without a login; one User has two different society roles',
      async () => {
        assert.equal(
          Number(
            await value(db, 'SELECT COUNT(*) AS value FROM users WHERE person_id = ?', [
              noLoginPerson,
            ]),
          ),
          0,
        );
        assert.equal(
          Number(
            await value(
              db,
              'SELECT COUNT(DISTINCT r.code) AS value FROM society_memberships m JOIN membership_roles mr ON mr.society_id = m.society_id AND mr.membership_id = m.id JOIN roles r ON r.society_id = mr.society_id AND r.id = mr.role_id WHERE m.user_id = ?',
              [user],
            ),
          ),
          2,
        );
      },
    );

    await suite.test('global accounts, membership and flat numbers cannot duplicate', async () => {
      await assert.rejects(
        insert(db, 'INSERT INTO users (person_id, email_normalized) VALUES (?, ?)', [
          noLoginPerson,
          'synthetic@example.invalid',
        ]),
        dbError('ER_DUP_ENTRY'),
      );
      await assert.rejects(
        insert(db, 'INSERT INTO users (person_id, email_normalized) VALUES (?, ?)', [
          person,
          'different@example.invalid',
        ]),
        dbError('ER_DUP_ENTRY'),
      );
      await assert.rejects(
        insert(db, 'INSERT INTO society_memberships (society_id, user_id) VALUES (?, ?)', [
          a.society,
          user,
        ]),
        dbError('ER_DUP_ENTRY'),
      );
      await assert.rejects(
        insert(
          db,
          "INSERT INTO flats (society_id, building_id, flat_number) VALUES (?, ?, '101')",
          [a.society, a.building],
        ),
        dbError('ER_DUP_ENTRY'),
      );
    });

    await suite.test(
      'owner, current tenant and historical tenant coexist; duplicate open occupancy fails',
      async () => {
        const occupancies: [number, string, string, string | null][] = [
          [person, 'OWNER', '2020-01-01', null],
          [noLoginPerson, 'TENANT', '2026-01-01', null],
          [person, 'TENANT', '2024-01-01', '2025-12-31'],
        ];
        for (const [resident, type, from, until] of occupancies)
          await insert(
            db,
            'INSERT INTO flat_occupancies (society_id, flat_id, person_id, occupancy_type, starts_on, ends_on) VALUES (?, ?, ?, ?, ?, ?)',
            [a.society, a.flat, resident, type, from, until],
          );
        assert.equal(
          Number(
            await value(
              db,
              'SELECT COUNT(*) AS value FROM flat_occupancies WHERE society_id = ? AND flat_id = ?',
              [a.society, a.flat],
            ),
          ),
          3,
        );
        await assert.rejects(
          insert(
            db,
            "INSERT INTO flat_occupancies (society_id, flat_id, person_id, occupancy_type, starts_on) VALUES (?, ?, ?, 'OWNER', '2026-01-01')",
            [a.society, a.flat, person],
          ),
          dbError('ER_DUP_ENTRY'),
        );
        await assert.rejects(
          insert(
            db,
            "INSERT INTO flat_occupancies (society_id, flat_id, person_id, starts_on, ends_on) VALUES (?, ?, ?, '2026-02-01', '2026-01-01')",
            [a.society, a.flat, person],
          ),
          dbError(3819),
        );
      },
    );

    await suite.test('missing and cross-tenant foreign keys fail', async () => {
      await assert.rejects(
        insert(
          db,
          "INSERT INTO flats (society_id, building_id, flat_number) VALUES (?, ?, '102')",
          [a.society, b.building],
        ),
        dbError('ER_NO_REFERENCED_ROW_2'),
      );
      await assert.rejects(
        insert(
          db,
          'INSERT INTO membership_roles (society_id, membership_id, role_id) VALUES (?, ?, ?)',
          [a.society, a.membership, b.role],
        ),
        dbError('ER_NO_REFERENCED_ROW_2'),
      );
      await assert.rejects(
        insert(
          db,
          "INSERT INTO flat_occupancies (society_id, flat_id, person_id, starts_on) VALUES (?, ?, ?, '2026-01-01')",
          [b.society, b.flat, noLoginPerson],
        ),
        dbError('ER_NO_REFERENCED_ROW_2'),
      );
      await assert.rejects(
        insert(
          db,
          "INSERT INTO buildings (society_id, code, name) VALUES (999999, 'X', 'Missing')",
        ),
        dbError('ER_NO_REFERENCED_ROW_2'),
      );
      await assert.rejects(
        insert(
          db,
          "INSERT INTO flat_occupancies (society_id, flat_id, person_id, starts_on) VALUES (?, 999999, ?, '2026-01-01')",
          [a.society, person],
        ),
        dbError('ER_NO_REFERENCED_ROW_2'),
      );
      await assert.rejects(
        insert(
          db,
          "INSERT INTO society_persons (society_id, person_id, display_name) VALUES (?, 999999, 'Missing')",
          [a.society],
        ),
        dbError('ER_NO_REFERENCED_ROW_2'),
      );
    });

    await suite.test(
      'payments, allocations and collectors cannot cross tenant or flat boundaries',
      async () => {
        await assert.rejects(
          insert(
            db,
            "INSERT INTO payments (society_id, flat_id, payer_person_id, payment_date, amount, collected_by_membership_id, recorded_by_membership_id, idempotency_key) VALUES (?, ?, ?, '2026-10-02', 1, ?, ?, 'cross-collector')",
            [a.society, a.flat, person, b.membership, a.membership],
          ),
          dbError('ER_NO_REFERENCED_ROW_2'),
        );
        await assert.rejects(
          insert(
            db,
            'INSERT INTO payment_allocations (society_id, payment_id, bill_id, flat_id, amount) VALUES (?, ?, ?, ?, 1)',
            [a.society, a.payment, b.bill, a.flat],
          ),
          dbError('ER_NO_REFERENCED_ROW_2'),
        );
        const otherFlat = await insert(
          db,
          "INSERT INTO flats (society_id, building_id, flat_number) VALUES (?, ?, '102')",
          [a.society, a.building],
        );
        const otherBill = await insert(
          db,
          "INSERT INTO bills (society_id, billing_period_id, flat_id, bill_number, total_amount) VALUES (?, ?, ?, 'B-002', 1)",
          [a.society, a.period, otherFlat],
        );
        await assert.rejects(
          insert(
            db,
            'INSERT INTO payment_allocations (society_id, payment_id, bill_id, flat_id, amount) VALUES (?, ?, ?, ?, 1)',
            [a.society, a.payment, otherBill, a.flat],
          ),
          dbError('ER_NO_REFERENCED_ROW_2'),
        );
      },
    );

    await suite.test(
      'currency columns are DECIMAL(12,2); mysql2 preserves cents as strings',
      async () => {
        assert.equal(
          await value(db, 'SELECT amount AS value FROM payments WHERE id = ?', [a.payment]),
          '100.25',
        );
        assert.equal(
          Number(
            await value(
              db,
              "SELECT COUNT(*) AS value FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME IN ('amount', 'rate', 'unit_rate', 'total_amount') AND (DATA_TYPE <> 'decimal' OR NUMERIC_PRECISION <> 12 OR NUMERIC_SCALE <> 2)",
            ),
          ),
          0,
        );
        await assert.rejects(
          insert(
            db,
            "INSERT INTO payments (society_id, flat_id, payer_person_id, method, payment_date, amount, recorded_by_membership_id, idempotency_key) VALUES (?, ?, ?, 'UPI', '2026-10-02', -1, ?, 'negative')",
            [a.society, a.flat, person, a.membership],
          ),
          dbError(3819),
        );
      },
    );

    await suite.test(
      'financial idempotency, one bill per flat/period and one receipt per payment',
      async () => {
        await assert.rejects(
          insert(
            db,
            "INSERT INTO payments (society_id, flat_id, payer_person_id, method, payment_date, amount, recorded_by_membership_id, idempotency_key) VALUES (?, ?, ?, 'UPI', '2026-10-02', 1, ?, 'fixture-payment-1')",
            [a.society, a.flat, person, a.membership],
          ),
          dbError('ER_DUP_ENTRY'),
        );
        await assert.rejects(
          insert(
            db,
            "INSERT INTO bills (society_id, billing_period_id, flat_id, bill_number, total_amount) VALUES (?, ?, ?, 'B-DUPLICATE', 100.25)",
            [a.society, a.period, a.flat],
          ),
          dbError('ER_DUP_ENTRY'),
        );
        await assert.rejects(
          insert(
            db,
            "INSERT INTO receipts (society_id, payment_id, receipt_number, issued_at, issued_by_membership_id) VALUES (?, ?, 'R-DUP', CURRENT_TIMESTAMP(6), ?)",
            [a.society, a.payment, a.membership],
          ),
          dbError('ER_DUP_ENTRY'),
        );
      },
    );

    await suite.test('issued bills and their items are frozen', async () => {
      await assert.rejects(
        db.execute('UPDATE bills SET total_amount = 0 WHERE id = ?', [a.bill]),
        dbError(1644),
      );
      await assert.rejects(db.execute('DELETE FROM bills WHERE id = ?', [a.bill]), dbError(1644));
      await assert.rejects(
        db.execute('UPDATE bill_items SET description = ? WHERE bill_id = ?', ['tampered', a.bill]),
        dbError(1644),
      );
      await assert.rejects(
        db.execute('DELETE FROM bill_items WHERE bill_id = ?', [a.bill]),
        dbError(1644),
      );
      await assert.rejects(
        insert(
          db,
          "INSERT INTO bill_items (society_id, bill_id, charge_configuration_id, line_number, description, quantity, unit_rate, amount) VALUES (?, ?, ?, 2, 'Late item', 1, 1, 1)",
          [a.society, a.bill, a.configuration],
        ),
        dbError(1644),
      );
    });

    await suite.test(
      'financial corrections append records; original payment and receipt survive',
      async () => {
        await insert(
          db,
          "INSERT INTO bill_adjustments (society_id, bill_id, amount, reason, idempotency_key, recorded_by_membership_id) VALUES (?, ?, 1, 'Synthetic correction', 'adjust-1', ?)",
          [a.society, a.bill, a.membership],
        );
        await insert(
          db,
          "INSERT INTO payment_reversals (society_id, payment_id, reason, reversed_by_membership_id, idempotency_key) VALUES (?, ?, 'Synthetic reversal', ?, 'reverse-1')",
          [a.society, a.payment, a.membership],
        );
        await assert.rejects(
          insert(
            db,
            "INSERT INTO payment_reversals (society_id, payment_id, reason, reversed_by_membership_id, idempotency_key) VALUES (?, ?, 'Duplicate reversal', ?, 'reverse-2')",
            [a.society, a.payment, a.membership],
          ),
          dbError('ER_DUP_ENTRY'),
        );
        for (const table of [
          'payments',
          'payment_allocations',
          'payment_reversals',
          'receipts',
          'bill_adjustments',
          'audit_logs',
        ]) {
          // Identifiers are a fixed test-owned allowlist; values remain parameterized.
          await assert.rejects(
            db.execute(`UPDATE ${table} SET society_id = ? WHERE society_id = ?`, [
              a.society,
              a.society,
            ]),
            dbError(1644),
          );
          await assert.rejects(
            db.execute(`DELETE FROM ${table} WHERE society_id = ?`, [a.society]),
            dbError(1644),
          );
        }
        assert.equal(
          Number(
            await value(
              db,
              'SELECT COUNT(*) AS value FROM receipts WHERE society_id = ? AND payment_id = ?',
              [a.society, a.payment],
            ),
          ),
          1,
        );
      },
    );

    await suite.test('parent deletion cannot cascade financial or audit records', async () => {
      await assert.rejects(
        db.execute('DELETE FROM societies WHERE id = ?', [a.society]),
        dbError('ER_ROW_IS_REFERENCED_2'),
      );
      await assert.rejects(
        db.execute('DELETE FROM flats WHERE id = ?', [a.flat]),
        dbError('ER_ROW_IS_REFERENCED_2'),
      );
      assert.equal(
        Number(
          await value(
            db,
            "SELECT COUNT(*) AS value FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND (DELETE_RULE NOT IN ('RESTRICT', 'NO ACTION') OR UPDATE_RULE NOT IN ('RESTRICT', 'NO ACTION'))",
          ),
        ),
        0,
      );
    });

    await suite.test(
      'invitations store unique hashes and one pending invitation per tenant/email',
      async () => {
        const sql =
          "INSERT INTO invitations (society_id, person_id, role_id, email_normalized, token_hash, expires_at, created_by_user_id) VALUES (?, ?, ?, 'invite@example.invalid', ?, DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 1 DAY), ?)";
        await insert(db, sql, [a.society, noLoginPerson, a.role, randomBytes(32), user]);
        await assert.rejects(
          insert(db, sql, [a.society, noLoginPerson, a.role, randomBytes(32), user]),
          dbError('ER_DUP_ENTRY'),
        );
        await assert.rejects(
          db.execute("UPDATE invitations SET status = 'ACCEPTED' WHERE society_id = ?", [
            a.society,
          ]),
          dbError('ER_SIGNAL_EXCEPTION'),
        );
        await assert.rejects(
          db.execute('UPDATE invitations SET expires_at = created_at WHERE society_id = ?', [
            a.society,
          ]),
          dbError('ER_SIGNAL_EXCEPTION'),
        );
      },
    );

    await suite.test(
      'registration stays pending and duplicate or unreviewed approval is rejected',
      async () => {
        const request = await insert(
          db,
          'INSERT INTO registration_requests (society_id, user_id, requested_flat_id) VALUES (?, ?, ?)',
          [b.society, user, b.flat],
        );
        assert.equal(
          await value(db, 'SELECT status AS value FROM registration_requests WHERE id = ?', [
            request,
          ]),
          'PENDING',
        );
        await assert.rejects(
          insert(
            db,
            'INSERT INTO registration_requests (society_id, user_id, requested_flat_id) VALUES (?, ?, ?)',
            [b.society, user, b.flat],
          ),
          dbError('ER_DUP_ENTRY'),
        );
        await assert.rejects(
          db.execute("UPDATE registration_requests SET status = 'APPROVED' WHERE id = ?", [
            request,
          ]),
          dbError('ER_SIGNAL_EXCEPTION'),
        );
        await assert.rejects(
          db.execute("UPDATE societies SET status = 'INVALID' WHERE id = ?", [a.society]),
          dbError(3819),
        );
      },
    );

    await suite.test('migration checksum drift and partial execution block a rerun', async () => {
      const original = migrations[0];
      assert.ok(original);
      try {
        await db.execute(
          "UPDATE _schema_migrations SET checksum = REPEAT('0', 64) WHERE version = 1",
        );
        await assert.rejects(migrate(db, migrations, process.env.DB_NAME ?? ''), /checksum/);
        await db.execute(
          "UPDATE _schema_migrations SET checksum = ?, status = 'STARTED' WHERE version = 1",
          [original.checksum],
        );
        await assert.rejects(migrate(db, migrations, process.env.DB_NAME ?? ''), /Partial/);
      } finally {
        await db.execute(
          "UPDATE _schema_migrations SET checksum = ?, status = 'APPLIED' WHERE version = 1",
          [original.checksum],
        );
      }
    });
    await suite.test('authentication and authorization HTTP security', async (authSuite) => {
      await authIntegration(authSuite, db);
    });
    await suite.test(
      'platform onboarding and committee verification security',
      async (onboardingSuite) => {
        await onboardingIntegration(onboardingSuite, db);
      },
    );
    await suite.test(
      'property management, CSV imports and tenant boundaries',
      async (propertySuite) => {
        await propertyIntegration(propertySuite, db);
      },
    );
    await suite.test(
      'resident invitations, registration approval and tenant identity',
      async (resident) => {
        await residentAccessIntegration(resident, db);
      },
    );
    await suite.test(
      'billing transactions, money, concurrency and tenant boundaries',
      async (billing) => {
        await billingIntegration(billing, db);
      },
    );
  } finally {
    await db.end();
  }
});
