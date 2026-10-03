import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import type { Connection, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { createFixture, insert } from './fixtures.js';
import { grantTestRuntime } from './runtime-provision.js';
import { openRuntime } from '../src/database/runtime.js';
import { provisionBillingPermissions } from '../src/database/billing-grants.js';
import { hashPassword } from '../src/auth/crypto.js';
import { AuthRepository } from '../src/auth/repository.js';
import { AuthService } from '../src/auth/service.js';
import { ResetQueue } from '../src/auth/reset-queue.js';
import { AuthClient } from './auth-client.js';
import { createApp } from '../src/http/app.js';
import { BillingAccess } from '../src/billing/access.js';
import { billingModule } from '../src/billing/router.js';
import { paymentModule } from '../src/payments/router.js';
import { PaymentWriter, PaymentRecording } from '../src/payments/recording.js';
import { PaymentLifecycle } from '../src/payments/lifecycle.js';
import { ApiError } from '../src/http/errors.js';
import type { RecordInput } from '../src/payments/contracts.js';
import type { TenantScope } from '../src/property/access.js';
import type { Session } from '../src/auth/types.js';
export async function paymentsIntegration(suite: TestContext, db: Connection): Promise<void> {
  const password = 'Synthetic Step 8 test password',
    encoded = await hashPassword(password);
  async function account(email: string) {
    const person = await insert(db, 'INSERT INTO persons() VALUES()');
    const user = await insert(
      db,
      "INSERT INTO users(person_id,email_normalized,password_hash,status) VALUES(?,?,?,'ACTIVE')",
      [person, email, encoded],
    );
    return { user, person, email };
  }
  const admin = await account('payments-admin@example.invalid'),
    other = await account('payments-other@example.invalid'),
    accountant = await account('payments-accountant@example.invalid'),
    resident = await account('payments-resident@example.invalid'),
    platform = await account('payments-platform@example.invalid');
  const a = await createFixture(db, 'PAYMENT_A', admin.user, admin.person, 'COMMITTEE_ADMIN'),
    b = await createFixture(db, 'PAYMENT_B', other.user, other.person, 'COMMITTEE_ADMIN');
  await db.execute("UPDATE societies SET status='ACTIVE' WHERE id IN (?,?)", [
    a.society,
    b.society,
  ]);
  for (const f of [a, b])
    await db.execute(
      "INSERT INTO role_permissions(society_id,role_id,permission_id) SELECT ?,?,id FROM permissions WHERE code IN ('society.dashboard.read','society.finance.read','society.finance.record')",
      [f.society, f.role],
    );
  for (const [u, code] of [
    [accountant, 'ACCOUNTANT'],
    [resident, 'RESIDENT'],
  ] as const) {
    await db.execute(
      'INSERT INTO society_persons(society_id,person_id,display_name) VALUES(?,?,?)',
      [a.society, u.person, 'Synthetic ' + code],
    );
    const membership = await insert(
      db,
      "INSERT INTO society_memberships(society_id,user_id,status,joined_at) VALUES(?,?,'ACTIVE',UTC_TIMESTAMP(6))",
      [a.society, u.user],
    );
    const role = await insert(db, 'INSERT INTO roles(society_id,code,name) VALUES(?,?,?)', [
      a.society,
      code,
      code,
    ]);
    await db.execute(
      'INSERT INTO membership_roles(society_id,membership_id,role_id) VALUES(?,?,?)',
      [a.society, membership, role],
    );
    await db.execute(
      "INSERT INTO role_permissions(society_id,role_id,permission_id) SELECT ?,?,id FROM permissions WHERE code IN ('society.dashboard.read','society.finance.read','society.finance.record','society.finance.reverse')",
      [a.society, role],
    );
  }
  await db.execute(
    "INSERT INTO platform_user_roles(user_id,role_code) VALUES(?,'PLATFORM_ADMIN')",
    [platform.user],
  );
  await provisionBillingPermissions(db);
  await provisionBillingPermissions(db);
  await grantTestRuntime();
  const database = await openRuntime(process.env),
    repository = new AuthRepository(database),
    queue = new ResetQueue(() => undefined),
    logs: string[] = [];
  const auth = await AuthService.create(
    repository,
    {
      origin: 'http://127.0.0.1:4200',
      secret: '8'.repeat(64),
      secure: false,
      cookieName: 'livora_session',
      idleMs: 1800000,
      absoluteMs: 43200000,
      resetMs: 1800000,
    },
    { send: () => Promise.resolve() },
    queue,
  );
  const access = new BillingAccess(database),
    module = paymentModule(access),
    billing = billingModule(access);
  const server = createApp(
    auth,
    (code) => logs.push(code),
    undefined,
    undefined,
    undefined,
    undefined,
    billing,
    module,
  ).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let nextRequest = Date.now();
  const client = () => {
    const c = new AuthClient('http://127.0.0.1:' + address.port, auth.config.origin),
      request = c.request.bind(c);
    c.request = async (path, body, extra) => {
      const slot = Math.max(nextRequest, Date.now());
      nextRequest = slot + 650;
      await delay(Math.max(0, slot - Date.now()));
      return request(path, body, extra);
    };
    return c;
  };
  const committee = client(),
    foreign = client(),
    bookkeeper = client(),
    occupant = client(),
    root = client(),
    anonymous = client();
  const audit = { requestId: 'payment-test', ipHash: Buffer.alloc(32) };
  let session: Session;
  const base = '/society/billing/payments';
  let index = 0;
  async function bill(amount: string, issued = true) {
    index++;
    const month = String(index).padStart(2, '0'),
      date = '2025-' + month + '-01';
    const period = await insert(
      db,
      'INSERT INTO billing_periods(society_id,code,starts_on,ends_on,due_on) VALUES(?,?,?,?,?)',
      [a.society, 'PAYMENT_' + index, date, date, date],
    );
    const id = await insert(
      db,
      'INSERT INTO bills(society_id,billing_period_id,flat_id,bill_number,total_amount) VALUES(?,?,?,?,?)',
      [a.society, period, a.flat, 'PAYMENT_BILL_' + index, amount],
    );
    await db.execute(
      "INSERT INTO bill_items(society_id,bill_id,charge_configuration_id,line_number,description,quantity,unit_rate,amount) VALUES(?,?,?,1,'Payment test charge',1,?,?)",
      [a.society, id, a.configuration, amount, amount],
    );
    if (issued)
      await db.execute(
        "UPDATE bills SET status='ISSUED',issued_at=UTC_TIMESTAMP(6),issued_by_membership_id=? WHERE id=?",
        [a.membership, id],
      );
    return String(id);
  }
  async function count(
    table:
      | 'payments'
      | 'receipts'
      | 'payment_allocations'
      | 'payment_details'
      | 'payment_reversals'
      | 'audit_logs',
  ) {
    const [values] = await db.query<(RowDataPacket & { count: number })[]>(
      'SELECT COUNT(*) AS count FROM ' + table + ' WHERE society_id=?',
      [a.society],
    );
    return values[0]?.count;
  }
  const input = (allocations: RecordInput['allocations'], amount: string): RecordInput => ({
    flatId: String(a.flat),
    payerPersonId: String(a.person),
    collectedByUserId: String(admin.user),
    method: 'CASH',
    paymentDate: '2026-10-02',
    amount,
    reference: '',
    notes: 'Synthetic payment',
    allocations,
    idempotencyKey: randomUUID(),
  });
  async function outstanding(id: string) {
    const result = await committee.request('/society/billing/bills/' + id);
    assert.equal(result.status, 200);
    return result.data['outstanding'];
  }
  const first = await bill('100.25'),
    second = await bill('200.75');
  let recorded = '',
    cashInput: RecordInput;
  try {
    for (const [c, u, society] of [
      [committee, admin, a.society],
      [foreign, other, b.society],
      [bookkeeper, accountant, a.society],
      [occupant, resident, a.society],
      [root, platform, null],
    ] as const) {
      await c.login(u.email, password);
      if (society)
        assert.equal(
          (await c.request('/auth/society-context', { societyId: String(society) })).status,
          204,
        );
    }
    const authenticated = await auth.readSession(committee.cookie.split('=')[1] ?? '');
    assert.ok(authenticated);
    session = authenticated;
    await suite.test(
      'payment and receipt APIs deny anonymous, resident and platform-only access',
      async () => {
        for (const c of [anonymous, occupant, root])
          assert.equal((await c.request(base)).status, c === anonymous ? 401 : 403);
        assert.equal((await foreign.request(base + '/' + a.payment + '/receipt')).status, 404);
        assert.equal((await committee.request(base + '?societyId=' + b.society)).status, 400);
      },
    );
    await suite.test(
      'partial allocation across two bills, immutable receipt and canonical retry',
      async () => {
        cashInput = input(
          [
            { billId: first, amount: '100.25' },
            { billId: second, amount: '49.75' },
          ],
          '150.00',
        );
        const result = await committee.request(base, cashInput);
        assert.equal(result.status, 201);
        recorded = String(result.data['paymentId']);
        assert.equal(await outstanding(first), '0.00');
        assert.equal(await outstanding(second), '151.00');
        const receipt = await committee.request(base + '/' + recorded + '/receipt');
        assert.equal(receipt.status, 200);
        assert.equal(receipt.headers.get('cache-control'), 'no-store');
        assert.equal(receipt.data['status'], 'RECORDED');
        assert.equal(receipt.data['collectedByUserId'], String(admin.user));
        assert.equal(receipt.data['recordedByUserId'], String(admin.user));
        assert.equal(receipt.data['paymentDate'], cashInput.paymentDate);
        assert.equal(receipt.data['amount'], '150.00');
        assert.equal(receipt.data['method'], 'CASH');
        assert.equal(receipt.data['receiptNumber'], 'R-' + a.society + '-' + recorded);
        const replay = await committee.request(base, {
          ...cashInput,
          amount: '150',
          allocations: [...cashInput.allocations].reverse(),
        });
        assert.equal(replay.status, 201);
        assert.equal(replay.data['paymentId'], recorded);
        assert.equal(replay.data['replayed'], true);
        assert.equal(
          (await committee.request(base, { ...cashInput, notes: 'Different request' })).status,
          409,
        );
        await db.execute(
          "UPDATE society_persons SET display_name='Changed current name' WHERE society_id=? AND person_id=?",
          [a.society, a.person],
        );
        assert.equal(
          (await committee.request(base + '/' + recorded + '/receipt')).data['payerName'],
          'Synthetic resident',
        );
      },
    );
    await suite.test(
      'excess allocations, wrong total, foreign IDs, forged recorder and invalid collector fail',
      async () => {
        const before = await count('payments');
        const draft = await bill('7.00', false);
        assert.equal(
          (await committee.request(base, input([{ billId: draft, amount: '1.00' }], '1.00')))
            .status,
          404,
        );
        const eligible = await committee.request(
          '/society/billing/bills?status=OUTSTANDING&flatId=' + a.flat,
        );
        assert.equal(eligible.status, 200);
        assert.ok(Array.isArray(eligible.data['items']));
        assert.ok(
          eligible.data['items'].every(
            (row: unknown) =>
              typeof row === 'object' && row !== null && 'id' in row && row.id !== draft,
          ),
        );
        assert.equal(
          (await committee.request(base, input([{ billId: second, amount: '151.01' }], '151.01')))
            .status,
          409,
        );
        assert.equal(
          (await committee.request(base, input([{ billId: second, amount: '1.00' }], '2.00')))
            .status,
          422,
        );
        for (const extra of [
          { flatId: String(b.flat) },
          { payerPersonId: String(b.person) },
          { collectedByUserId: String(other.user) },
          { collectedByUserId: String(resident.user) },
          { allocations: [{ billId: String(b.bill), amount: '1.00' }] },
        ])
          assert.equal(
            (
              await committee.request(base, {
                ...input([{ billId: second, amount: '1.00' }], '1.00'),
                ...extra,
              })
            ).status,
            404,
          );
        assert.equal(
          (
            await committee.request(base, {
              ...input([{ billId: second, amount: '1.00' }], '1.00'),
              recordedByUserId: String(other.user),
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await committee.request(base, {
              ...input([{ billId: second, amount: '1.00' }], '1.00'),
              paymentDate: '2099-01-01',
            })
          ).status,
          422,
        );
        assert.equal(
          (
            await committee.request(base, input([{ billId: second, amount: '1.00' }], '1.00'), {
              'X-CSRF-Token': 'invalid',
            })
          ).status,
          403,
        );
        await db.execute("UPDATE users SET status='DISABLED' WHERE id=?", [accountant.user]);
        try {
          assert.equal(
            (
              await committee.request(base, {
                ...input([{ billId: second, amount: '1.00' }], '1.00'),
                collectedByUserId: String(accountant.user),
              })
            ).status,
            404,
          );
        } finally {
          await db.execute("UPDATE users SET status='ACTIVE' WHERE id=?", [accountant.user]);
        }
        // Disabling an account revokes its sessions; a restored account must sign in again.
        await bookkeeper.login(accountant.email, password);
        assert.equal(
          (await bookkeeper.request('/auth/society-context', { societyId: String(a.society) }))
            .status,
          204,
        );
        assert.equal(await count('payments'), before);
      },
    );
    await suite.test(
      'partial then full refunds release only original allocations and prevent reuse or reversal',
      async () => {
        const request = {
          reason: 'Synthetic physical refund',
          operationDate: '2026-10-02',
          method: 'CASH',
          reference: '',
          amount: '25.00',
          allocations: [{ billId: second, amount: '25.00' }],
          idempotencyKey: randomUUID(),
        };
        const result = await committee.request(base + '/' + recorded + '/refund', request);
        assert.equal(result.status, 200);
        assert.equal(await outstanding(second), '176.00');
        assert.equal(
          (await committee.request(base + '/' + recorded + '/refund', request)).data['refundId'],
          result.data['refundId'],
        );
        assert.equal(
          (
            await bookkeeper.request(base + '/' + recorded + '/refund', {
              ...request,
              idempotencyKey: randomUUID(),
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await foreign.request(base + '/' + recorded + '/refund', {
              ...request,
              idempotencyKey: randomUUID(),
            })
          ).status,
          404,
        );
        assert.equal(
          (
            await committee.request(base + '/' + recorded + '/refund', {
              ...request,
              amount: '30.00',
              allocations: [{ billId: second, amount: '30.00' }],
              idempotencyKey: randomUUID(),
            })
          ).status,
          409,
        );
        const full = {
          ...request,
          method: 'CASH' as const,
          amount: '125.00',
          allocations: [
            { billId: first, amount: '100.25' },
            { billId: second, amount: '24.75' },
          ],
        };
        const refunds = await Promise.allSettled([
          module.lifecycle.refund(
            session,
            recorded,
            { ...full, idempotencyKey: randomUUID() },
            audit,
          ),
          module.lifecycle.refund(
            session,
            recorded,
            { ...full, idempotencyKey: randomUUID() },
            audit,
          ),
        ]);
        assert.equal(refunds.filter((r) => r.status === 'fulfilled').length, 1);
        const rejected = refunds.find((r) => r.status === 'rejected');
        assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof ApiError);
        assert.equal(rejected.reason.code, 'PAYMENT_STATE');
        assert.equal(await outstanding(first), '100.25');
        assert.equal(await outstanding(second), '200.75');
        const receipt = await committee.request(base + '/' + recorded + '/receipt');
        assert.equal(receipt.data['amount'], '150.00');
        assert.equal(receipt.data['status'], 'REFUNDED');
        assert.equal(
          (
            await committee.request(base + '/' + recorded + '/reverse', {
              reason: 'Cannot reverse refunded',
              operationDate: '2026-10-02',
              idempotencyKey: randomUUID(),
            })
          ).status,
          409,
        );
      },
    );
    await suite.test(
      'non-cash references prevent duplicate recordings and full reversals retain receipts',
      async () => {
        const request = {
          ...input(
            [
              { billId: first, amount: '100.25' },
              { billId: second, amount: '200.75' },
            ],
            '301.00',
          ),
          method: 'UPI',
          reference: randomUUID(),
        };
        const result = await committee.request(base, request);
        assert.equal(result.status, 201);
        const id = String(result.data['paymentId']);
        const upi = await committee.request(base + '/' + id + '/receipt');
        assert.equal(upi.data['method'], 'UPI');
        assert.equal(upi.data['reference'], request.reference);
        const spare = await bill('10.00');
        const duplicate = {
          ...input([{ billId: spare, amount: '1.00' }], '1.00'),
          method: 'UPI',
          reference: ' ' + request.reference.toUpperCase() + ' ',
        };
        const rejected = await committee.request(base, duplicate);
        assert.equal(rejected.status, 409);
        assert.match(rejected.raw, /DUPLICATE_REFERENCE/);
        const reverse = {
          reason: 'Synthetic incorrect record',
          operationDate: '2026-10-02',
          idempotencyKey: randomUUID(),
        };
        assert.equal((await committee.request(base + '/' + id + '/reverse', reverse)).status, 200);
        assert.equal(
          (await committee.request(base + '/' + id + '/reverse', reverse)).data['replayed'],
          true,
        );
        assert.equal(await outstanding(first), '100.25');
        assert.equal(await outstanding(second), '200.75');
        assert.equal(
          (await committee.request(base + '/' + id + '/receipt')).data['status'],
          'REVERSED',
        );
        assert.equal(
          (
            await committee.request(base + '/' + id + '/refund', {
              ...reverse,
              amount: '1.00',
              method: 'CASH',
              allocations: [{ billId: first, amount: '1.00' }],
            })
          ).status,
          409,
        );
        const cheque = {
          ...input([{ billId: spare, amount: '2.37' }], '2.37'),
          method: 'CHEQUE',
          reference: 'Synthetic cheque ' + randomUUID(),
          collectedByUserId: String(accountant.user),
        };
        const chequeResult = await committee.request(base, cheque);
        assert.equal(chequeResult.status, 201);
        const chequeReceipt = await committee.request(
          base + '/' + String(chequeResult.data['paymentId']) + '/receipt',
        );
        assert.equal(chequeReceipt.status, 200);
        assert.equal(chequeReceipt.data['method'], 'CHEQUE');
        assert.equal(chequeReceipt.data['reference'], cheque.reference);
        assert.equal(chequeReceipt.data['paymentDate'], cheque.paymentDate);
        assert.equal(chequeReceipt.data['amount'], '2.37');
        assert.equal(chequeReceipt.data['collectedByUserId'], String(accountant.user));
        assert.equal(chequeReceipt.data['recordedByUserId'], String(admin.user));
        assert.equal(await outstanding(spare), '7.63');
      },
    );
    await suite.test(
      'simultaneous requests prevent overpayment and identical keys return one payment',
      async () => {
        const target = await bill('50.00'),
          request = input([{ billId: target, amount: '50.00' }], '50.00');
        const response = await Promise.all([
          module.recording.record(session, request, audit),
          module.recording.record(session, request, audit),
        ]);
        assert.equal(response[0]?.paymentId, response[1]?.paymentId);
        assert.equal(response.filter((r) => r.replayed).length, 1);
        assert.equal(await outstanding(target), '0.00');
        const otherSession = await auth.readSession(bookkeeper.cookie.split('=')[1] ?? '');
        assert.ok(otherSession);
        const target2 = await bill('25.00');
        const race = await Promise.allSettled([
          module.recording.record(
            session,
            input([{ billId: target2, amount: '25.00' }], '25.00'),
            audit,
          ),
          module.recording.record(
            otherSession,
            input([{ billId: target2, amount: '25.00' }], '25.00'),
            audit,
          ),
        ]);
        assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
        assert.equal(race.filter((r) => r.status === 'rejected').length, 1);
        const rejected = race.find((r) => r.status === 'rejected');
        assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof ApiError);
        assert.equal(rejected.reason.code, 'OVERPAYMENT');
        assert.equal(await outstanding(target2), '0.00');
      },
    );
    await suite.test(
      'correction reverses and replaces atomically, numbering is unique and parents remain',
      async () => {
        const target = await bill('50.00');
        const original = await module.recording.record(
          session,
          input([{ billId: target, amount: '50.00' }], '50.00'),
          audit,
        );
        const replacement = {
          ...input([{ billId: target, amount: '50.00' }], '50.00'),
          method: 'BANK_TRANSFER' as const,
          reference: randomUUID(),
        };
        const { idempotencyKey: ignored, ...fields } = replacement;
        assert.ok(ignored);
        const correction = {
          reason: 'Correct synthetic payment method',
          operationDate: '2026-10-02',
          idempotencyKey: randomUUID(),
          replacement: fields,
        };
        const result = await module.lifecycle.correct(
          session,
          original.paymentId,
          correction,
          audit,
        );
        assert.ok(result.replacementPaymentId);
        assert.equal(
          (await module.lifecycle.correct(session, original.paymentId, correction, audit))
            .replacementPaymentId,
          result.replacementPaymentId,
        );
        assert.equal(await outstanding(target), '0.00');
        const old = await module.queries.detail(session, original.paymentId),
          updated = await module.queries.detail(session, result.replacementPaymentId);
        assert.equal(old.status, 'REVERSED');
        assert.equal(updated.correctedFromPaymentId, original.paymentId);
        const bankReceipt = await committee.request(
          base + '/' + result.replacementPaymentId + '/receipt',
        );
        assert.equal(bankReceipt.status, 200);
        assert.equal(bankReceipt.data['method'], 'BANK_TRANSFER');
        assert.equal(bankReceipt.data['reference'], replacement.reference);
        assert.notEqual(old.receiptNumber, updated.receiptNumber);
        await assert.rejects(
          db.execute('UPDATE payments SET amount=1 WHERE id=?', [original.paymentId]),
        );
        await assert.rejects(db.execute('DELETE FROM payments WHERE id=?', [original.paymentId]));
        await assert.rejects(db.execute('DELETE FROM societies WHERE id=?', [a.society]));
      },
    );
    await suite.test(
      'writer failure rolls back allocations, receipt, audit and correction reversal',
      async () => {
        class FailingWriter extends PaymentWriter {
          override async write(
            connection: PoolConnection,
            scope: TenantScope,
            value: RecordInput,
            now: number,
          ): Promise<string> {
            await super.write(connection, scope, value, now);
            throw new Error('Injected payment failure');
          }
        }
        const tables = [
          'payments',
          'payment_allocations',
          'receipts',
          'payment_details',
          'payment_reversals',
          'audit_logs',
        ] as const;
        const target = await bill('10.00'),
          request = input([{ billId: target, amount: '10.00' }], '10.00');
        const before = await Promise.all(tables.map(count));
        await assert.rejects(
          new PaymentRecording(access, new FailingWriter()).record(session, request, audit),
          /Injected/,
        );
        assert.deepEqual(await Promise.all(tables.map(count)), before);
        assert.equal(await outstanding(target), '10.00');
        const original = await module.recording.record(session, request, audit),
          beforeCorrection = await Promise.all(tables.map(count));
        const { idempotencyKey: ignored, ...replacement } = request;
        assert.ok(ignored);
        await assert.rejects(
          new PaymentLifecycle(access, new FailingWriter()).correct(
            session,
            original.paymentId,
            {
              reason: 'Injected correction rollback',
              operationDate: '2026-10-02',
              idempotencyKey: randomUUID(),
              replacement,
            },
            audit,
          ),
          /Injected/,
        );
        assert.deepEqual(await Promise.all(tables.map(count)), beforeCorrection);
        assert.equal((await module.queries.detail(session, original.paymentId)).status, 'RECORDED');
      },
    );
    await suite.test(
      'failure on the second allocation rolls back the payment and permits the same-key retry',
      async () => {
        // This trigger exists only in the fresh integration schema. The connection flag
        // isolates fault injection from normal writes and leaves production SQL unchanged.
        await db.query(`CREATE TRIGGER test_payment_allocation_failure BEFORE INSERT ON payment_allocations
          FOR EACH ROW BEGIN
            IF @livora_test_fail_allocations = 1 AND EXISTS(
              SELECT 1 FROM payment_allocations
              WHERE society_id=NEW.society_id AND payment_id=NEW.payment_id
            ) THEN
              SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Injected failure after first allocation';
            END IF;
          END`);
        class AllocationFailure extends PaymentWriter {
          override async write(...args: Parameters<PaymentWriter['write']>): Promise<string> {
            const [connection] = args;
            await connection.query('SET @livora_test_fail_allocations = 1');
            try {
              return await super.write(...args);
            } finally {
              await connection.query('SET @livora_test_fail_allocations = NULL');
            }
          }
        }
        const request = input(
          [
            { billId: first, amount: '1.11' },
            { billId: second, amount: '2.22' },
          ],
          '3.33',
        );
        const tables = [
          'payments',
          'payment_allocations',
          'receipts',
          'payment_details',
          'audit_logs',
        ] as const;
        const before = await Promise.all(tables.map(count));
        const balances = await Promise.all([outstanding(first), outstanding(second)]);
        await assert.rejects(
          new PaymentRecording(access, new AllocationFailure()).record(session, request, audit),
          /Injected failure after first allocation/,
        );
        assert.deepEqual(await Promise.all(tables.map(count)), before);
        assert.deepEqual(await Promise.all([outstanding(first), outstanding(second)]), balances);
        const [commands] = await db.execute<RowDataPacket[]>(
          'SELECT id FROM payment_commands WHERE society_id=? AND idempotency_key=?',
          [a.society, request.idempotencyKey],
        );
        assert.equal(commands.length, 0);
        const retry = await committee.request(base, request);
        assert.equal(retry.status, 201);
        assert.equal(retry.data['replayed'], false);
        const receipt = await committee.request(
          base + '/' + String(retry.data['paymentId']) + '/receipt',
        );
        assert.equal(receipt.data['amount'], '3.33');
        assert.ok(Array.isArray(receipt.data['allocations']));
        assert.equal(receipt.data['allocations'].length, 2);
        assert.equal(await outstanding(first), '99.14');
        assert.equal(await outstanding(second), '198.53');
      },
    );
    await suite.test(
      'report reconciles retained ledger, supports collector/date/method and paginates',
      async () => {
        const response = await committee.request(base + '/report');
        assert.equal(response.status, 200);
        const summary = response.data['summary'];
        assert.ok(typeof summary === 'object' && summary !== null && 'netRecorded' in summary);
        const [values] = await db.query<(RowDataPacket & { net: string })[]>(
          `SELECT COALESCE(SUM(p.amount),0)-COALESCE((SELECT SUM(p2.amount) FROM payment_reversals r JOIN payments p2 ON p2.society_id=r.society_id AND p2.id=r.payment_id WHERE r.society_id=?),0)-COALESCE((SELECT SUM(amount) FROM payment_refunds WHERE society_id=?),0) AS net FROM payments p WHERE p.society_id=?`,
          [a.society, a.society, a.society],
        );
        assert.equal(summary.netRecorded, values[0]?.net);
        const [allocated] = await db.query<(RowDataPacket & { net: string })[]>(
          `SELECT COALESCE(SUM(a.amount-COALESCE((SELECT SUM(r.amount) FROM payment_refund_allocations r WHERE r.society_id=a.society_id AND r.allocation_id=a.id),0)),0) AS net FROM payment_allocations a WHERE a.society_id=? AND NOT EXISTS(SELECT 1 FROM payment_reversals v WHERE v.society_id=a.society_id AND v.payment_id=a.payment_id)`,
          [a.society],
        );
        assert.equal(summary.netRecorded, allocated[0]?.net);
        const filtered = await committee.request(
          base +
            '/report?from=2026-10-02&to=2026-10-02&method=CASH&collectorUserId=' +
            admin.user +
            '&pageSize=1',
        );
        assert.equal(filtered.status, 200);
        assert.ok(Array.isArray(filtered.data['items']));
        assert.equal(filtered.data['items'].length, 1);
        const none = await committee.request(base + '/report?collectorUserId=' + other.user);
        assert.equal(none.data['total'], 0);
        assert.equal(
          (await committee.request(base + '/report?from=2026-10-03&to=2026-10-02')).status,
          400,
        );
        const collectors = await committee.request(base + '/collectors');
        assert.equal(collectors.status, 200);
        assert.ok(Array.isArray(collectors.data['items']));
        assert.equal(collectors.data['items'].length, 2);
        const payers = await committee.request(base + '/payers?pageSize=1');
        assert.equal(payers.status, 200);
        assert.ok(Array.isArray(payers.data['items']));
        assert.equal(payers.data['items'].length, 1);
        const historicalBill = await bill('1.00');
        await module.recording.record(
          session,
          {
            ...input([{ billId: historicalBill, amount: '1.00' }], '1.00'),
            collectedByUserId: String(accountant.user),
          },
          audit,
        );
        await db.execute("UPDATE users SET status='DISABLED' WHERE id=?", [accountant.user]);
        await db.execute(
          "UPDATE society_persons SET display_name='Changed archived collector',archived_at=UTC_TIMESTAMP(6) WHERE society_id=? AND person_id=?",
          [a.society, accountant.person],
        );
        const historical = await committee.request(
          base + '/report-collectors?q=Synthetic%20ACCOUNTANT',
        );
        assert.equal(historical.status, 200);
        assert.ok(Array.isArray(historical.data['items']));
        assert.deepEqual(historical.data['items'], [
          { id: String(accountant.user), name: 'Synthetic ACCOUNTANT' },
        ]);
        assert.equal((await committee.request(base + '/collectors')).data['total'], 1);
        await assert.rejects(
          db.execute('UPDATE payment_details SET payer_name=payer_name WHERE society_id=?', [
            a.society,
          ]),
        );
        await assert.rejects(
          db.execute('DELETE FROM payment_refunds WHERE society_id=?', [a.society]),
        );
        await assert.rejects(
          db.execute(
            'INSERT INTO payment_allocations(society_id,payment_id,bill_id,flat_id,amount) VALUES(?,?,?,?,0.01)',
            [a.society, recorded, second, a.flat],
          ),
        );
        assert.deepEqual(logs, []);
        await db.execute(
          "DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.society_id=? AND rp.role_id=? AND p.code='society.finance.record'",
          [a.society, a.role],
        );
        await assert.rejects(
          module.recording.record(
            session,
            input([{ billId: second, amount: '1.00' }], '1.00'),
            audit,
          ),
          (error: unknown) => error instanceof ApiError && error.code === 'ACCESS_DENIED',
        );
      },
    );
  } finally {
    server.close();
    await once(server, 'close');
    await queue.idle();
    await database.pool.end();
  }
}
