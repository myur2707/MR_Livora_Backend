import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import type { Connection, RowDataPacket } from 'mysql2/promise';
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
import { BillingGeneration, BillWriter } from '../src/billing/generation.js';
import { parse, periodInput, typeInput } from '../src/billing/contracts.js';
import type {
  ConfigurationInput,
  PreviewInput,
  GenerationInput,
} from '../src/billing/contracts.js';
import type { Session } from '../src/auth/types.js';
export async function billingIntegration(suite: TestContext, db: Connection): Promise<void> {
  const password = 'Synthetic Step 7 test password';
  const encoded = await hashPassword(password);
  async function account(email: string) {
    const person = await insert(db, 'INSERT INTO persons() VALUES()');
    const user = await insert(
      db,
      "INSERT INTO users(person_id,email_normalized,password_hash,status) VALUES(?,?,?,'ACTIVE')",
      [person, email, encoded],
    );
    return { email, person, user };
  }
  const admin = await account('billing-admin@example.invalid'),
    other = await account('billing-other@example.invalid'),
    accountant = await account('billing-accountant@example.invalid'),
    resident = await account('billing-resident@example.invalid'),
    platform = await account('billing-platform@example.invalid');
  const a = await createFixture(db, 'BILLING_A', admin.user, admin.person, 'COMMITTEE_ADMIN'),
    b = await createFixture(db, 'BILLING_B', other.user, other.person, 'COMMITTEE_ADMIN');
  await db.execute("UPDATE societies SET status='ACTIVE' WHERE id IN (?,?)", [
    a.society,
    b.society,
  ]);
  for (const f of [a, b])
    await db.execute(
      "INSERT INTO role_permissions(society_id,role_id,permission_id) SELECT ?,?,id FROM permissions WHERE code IN ('society.dashboard.read','society.finance.read','society.finance.record')",
      [f.society, f.role],
    );
  for (const [person, roleCode] of [
    [accountant, 'ACCOUNTANT'],
    [resident, 'RESIDENT'],
  ] as const) {
    await db.execute(
      'INSERT INTO society_persons(society_id,person_id,display_name) VALUES(?,?,?)',
      [a.society, person.person, 'Synthetic billing member'],
    );
    const membership = await insert(
      db,
      "INSERT INTO society_memberships(society_id,user_id,status,joined_at) VALUES(?,?,'ACTIVE',UTC_TIMESTAMP(6))",
      [a.society, person.user],
    );
    const role = await insert(db, 'INSERT INTO roles(society_id,code,name) VALUES(?,?,?)', [
      a.society,
      roleCode,
      roleCode,
    ]);
    await db.execute(
      'INSERT INTO membership_roles(society_id,membership_id,role_id) VALUES(?,?,?)',
      [a.society, membership, role],
    );
    await db.execute(
      "INSERT INTO role_permissions(society_id,role_id,permission_id) SELECT ?,?,id FROM permissions WHERE code IN ('society.dashboard.read','society.finance.read','society.finance.record')",
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
  const database = await openRuntime(process.env);
  const repository = new AuthRepository(database);
  const queue = new ResetQueue(() => undefined);
  const logs: string[] = [];
  const auth = await AuthService.create(
    repository,
    {
      origin: 'http://127.0.0.1:4200',
      secret: '7'.repeat(64),
      secure: false,
      cookieName: 'livora_session',
      idleMs: 1800000,
      absoluteMs: 43200000,
      resetMs: 1800000,
    },
    { send: () => Promise.resolve() },
    queue,
  );
  const access = new BillingAccess(database);
  const module = billingModule(access);
  const server = createApp(
    auth,
    (code) => logs.push(code),
    undefined,
    undefined,
    undefined,
    undefined,
    module,
  ).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let nextRequest = Date.now();
  const client = () => {
    const c = new AuthClient('http://127.0.0.1:' + address.port, auth.config.origin);
    const request = c.request.bind(c);
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
  const audit = { requestId: 'billing-test', ipHash: Buffer.alloc(32) };
  async function session(c: AuthClient): Promise<Session> {
    const value = await auth.readSession(c.cookie.split('=')[1] ?? '');
    assert.ok(value);
    return value;
  }
  const base: ConfigurationInput = {
    chargeTypeId: '',
    scope: 'SOCIETY',
    calculationMethod: 'FLAT_RATE',
    rate: '100.00',
    effectiveFrom: '2026-01-01',
    effectiveUntil: null,
    eligibility: 'ALL_FLATS',
    enabled: true,
  };
  let periodId = '',
    typeId = '',
    flat = '',
    vacant = '',
    issued = '',
    adminSession: Session;
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
    adminSession = await session(committee);
    await suite.test(
      'finance boundaries deny anonymous, resident ceiling and platform-only access',
      async () => {
        assert.equal((await anonymous.request('/society/billing/bills')).status, 401);
        assert.equal((await occupant.request('/society/billing/bills')).status, 403);
        assert.equal((await root.request('/society/billing/bills')).status, 403);
        assert.equal(
          (
            await bookkeeper.request('/society/billing/charge-types', {
              code: 'NO',
              name: 'No',
              frequency: 'MONTHLY',
            })
          ).status,
          403,
        );
        assert.equal(
          (await committee.request('/society/billing/periods', { societyId: String(b.society) }))
            .status,
          400,
        );
        assert.equal(
          (await committee.request('/society/billing/periods', {}, { 'X-CSRF-Token': 'invalid' }))
            .status,
          403,
        );
      },
    );
    await suite.test(
      'configuration and monthly periods validate identifiers and preserve full monthly amounts',
      async () => {
        periodId = (
          await module.configuration.addPeriod(
            adminSession,
            parse(periodInput, {
              code: 'NOVEMBER',
              kind: 'MONTHLY',
              startsOn: '2026-11-01',
              endsOn: '2026-11-30',
              dueOn: '2026-11-10',
            }),
            audit,
          )
        ).id;
        flat = String(
          await insert(
            db,
            "INSERT INTO flats(society_id,building_id,flat_number,area_sq_ft) VALUES(?,?,'102',12.50)",
            [a.society, a.building],
          ),
        );
        vacant = String(
          await insert(
            db,
            "INSERT INTO flats(society_id,building_id,flat_number,area_sq_ft) VALUES(?,?,'103',12.50)",
            [a.society, a.building],
          ),
        );
        await db.execute(
          "INSERT INTO flat_occupancies(society_id,flat_id,person_id,occupancy_type,starts_on) VALUES(?,?,?,'OWNER','2026-10-15')",
          [a.society, flat, admin.person],
        );
        const [types] = await db.execute<(RowDataPacket & { id: string })[]>(
          'SELECT id FROM maintenance_charge_types WHERE society_id=?',
          [a.society],
        );
        typeId = String(types[0]?.id);
        await module.configuration.addConfiguration(
          adminSession,
          {
            ...base,
            chargeTypeId: typeId,
            scope: 'BUILDING',
            buildingId: String(a.building),
            rate: '200.00',
          },
          audit,
        );
        await module.configuration.addConfiguration(
          adminSession,
          { ...base, chargeTypeId: typeId, scope: 'FLAT', flatId: flat, rate: '300.00' },
          audit,
        );
        await module.configuration.addConfiguration(
          adminSession,
          {
            ...base,
            chargeTypeId: typeId,
            scope: 'FLAT',
            flatId: flat,
            rate: '900.00',
            effectiveFrom: '2026-11-15',
          },
          audit,
        );
        await assert.rejects(
          module.configuration.addConfiguration(
            adminSession,
            { ...base, chargeTypeId: typeId, flatId: String(b.flat), scope: 'FLAT' },
            audit,
          ),
          { status: 404 },
        );
        const areaType = await module.configuration.addType(
          adminSession,
          parse(typeInput, { code: 'AREA', name: 'Area charge', frequency: 'MONTHLY' }),
          audit,
        );
        await module.configuration.addConfiguration(
          adminSession,
          {
            ...base,
            chargeTypeId: areaType.id,
            calculationMethod: 'PER_SQ_FT',
            rate: '0.05',
            eligibility: 'OCCUPIED_ONLY',
          },
          audit,
        );
        const preview = await module.generation.preview(adminSession, {
          periodId,
          flatIds: [flat, vacant],
          discounts: [],
        });
        assert.equal(preview.flats.find((f) => f.flatId === flat)?.gross, '300.63');
        assert.equal(preview.flats.find((f) => f.flatId === vacant)?.gross, '200.00');
        assert.ok(
          preview.flats
            .find((f) => f.flatId === vacant)
            ?.exclusions.some((e) => e.includes('Vacant')),
        );
      },
    );
    await suite.test(
      'discount permission, exact rounding, final snapshots and retry semantics',
      async () => {
        const input: PreviewInput = {
          periodId,
          flatIds: [flat],
          discounts: [
            {
              flatId: flat,
              kind: 'PERCENT',
              value: '33.33',
              reason: 'Explicit committee approval',
            },
          ],
        };
        assert.equal((await bookkeeper.request('/society/billing/preview', input)).status, 403);
        const preview = await module.generation.preview(adminSession, input);
        assert.equal(preview.discount, '100.20');
        assert.equal(preview.net, '200.43');
        const request = {
          ...input,
          previewHash: preview.previewHash,
          idempotencyKey: randomUUID(),
        };
        const generated = await module.generation.generate(adminSession, request, audit);
        issued = generated.billIds[0] ?? '';
        assert.ok(issued);
        assert.deepEqual(
          (await module.generation.generate(adminSession, request, audit)).billIds,
          generated.billIds,
        );
        await assert.rejects(
          module.generation.generate(adminSession, { ...request, discounts: [] }, audit),
          { status: 409 },
        );
        const detail = await module.queries.detail(adminSession, issued);
        assert.equal(detail.gross, '300.63');
        assert.equal(detail.net, '200.43');
        assert.equal(detail.outstanding, '200.43');
        assert.equal(detail.adjustments.length, 1);
        await module.configuration.addConfiguration(
          adminSession,
          {
            ...base,
            chargeTypeId: typeId,
            scope: 'FLAT',
            flatId: flat,
            rate: '10.00',
            effectiveFrom: '2026-11-01',
          },
          audit,
        );
        assert.equal((await module.queries.detail(adminSession, issued)).gross, '300.63');
        await assert.rejects(db.execute('UPDATE bills SET total_amount=1 WHERE id=?', [issued]), {
          code: 'ER_SIGNAL_EXCEPTION',
        });
        await assert.rejects(
          db.execute('UPDATE maintenance_charge_configurations SET rate=1 WHERE id=?', [
            a.configuration,
          ]),
          { code: 'ER_SIGNAL_EXCEPTION' },
        );
        const [events] = await db.execute<RowDataPacket[]>(
          "SELECT id FROM audit_logs WHERE society_id=? AND action='BILL_DISCOUNT_AUTHORIZED'",
          [a.society],
        );
        assert.equal(events.length, 1);
      },
    );
    await suite.test(
      'stale previews and concurrent distinct request keys cannot double issue',
      async () => {
        const input = { periodId, flatIds: [vacant], discounts: [] };
        const old = await module.generation.preview(adminSession, input);
        await module.configuration.addConfiguration(
          adminSession,
          {
            ...base,
            chargeTypeId: typeId,
            scope: 'BUILDING',
            buildingId: String(a.building),
            rate: '210.00',
          },
          audit,
        );
        await assert.rejects(
          module.generation.generate(
            adminSession,
            { ...input, previewHash: old.previewHash, idempotencyKey: 'stale-preview-123456' },
            audit,
          ),
          { status: 409 },
        );
        const preview = await module.generation.preview(adminSession, input);
        const results = await Promise.allSettled(
          ['concurrent-first-123', 'concurrent-second-123'].map((idempotencyKey) =>
            module.generation.generate(
              adminSession,
              { ...input, previewHash: preview.previewHash, idempotencyKey },
              audit,
            ),
          ),
        );
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
        assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
        const [bills] = await db.execute<RowDataPacket[]>(
          'SELECT id FROM bills WHERE society_id=? AND billing_period_id=? AND flat_id=?',
          [a.society, periodId, vacant],
        );
        assert.equal(bills.length, 1);
      },
    );
    await suite.test(
      'expired and disabled overrides never fall back to a cheaper default',
      async () => {
        const next = await module.configuration.addPeriod(
          adminSession,
          parse(periodInput, {
            code: 'DECEMBER',
            kind: 'MONTHLY',
            startsOn: '2026-12-01',
            endsOn: '2026-12-31',
            dueOn: '2026-12-10',
          }),
          audit,
        );
        await module.configuration.addConfiguration(
          adminSession,
          { ...base, chargeTypeId: typeId, scope: 'FLAT', flatId: vacant, enabled: false },
          audit,
        );
        await module.configuration.addConfiguration(
          adminSession,
          {
            ...base,
            chargeTypeId: typeId,
            scope: 'FLAT',
            flatId: flat,
            effectiveFrom: '2026-12-01',
            effectiveUntil: '2026-12-01',
          },
          audit,
        );
        const preview = await module.generation.preview(adminSession, {
          periodId: next.id,
          flatIds: [flat, vacant],
          discounts: [],
        });
        assert.equal(preview.flats.find((f) => f.flatId === vacant)?.status, 'NO_CHARGES');
        assert.equal(preview.flats.find((f) => f.flatId === flat)?.previousOutstanding, '200.43');
        const future = await module.configuration.addPeriod(
          adminSession,
          parse(periodInput, {
            code: 'JANUARY',
            kind: 'MONTHLY',
            startsOn: '2027-01-01',
            endsOn: '2027-01-31',
            dueOn: '2027-01-10',
          }),
          audit,
        );
        assert.ok(
          (
            await module.generation.preview(adminSession, {
              periodId: future.id,
              flatIds: [flat],
              discounts: [],
            })
          ).flats[0]?.exclusions.some((e) => e.includes('Expired')),
        );
      },
    );
    await suite.test(
      'one-time events are consumed once per flat, across periods and versions',
      async () => {
        const charge = await module.configuration.addType(
          adminSession,
          parse(typeInput, { code: 'REPAIR', name: 'Repair event', frequency: 'ONE_TIME' }),
          audit,
        );
        await module.configuration.addConfiguration(
          adminSession,
          { ...base, chargeTypeId: charge.id, rate: '12.34' },
          audit,
        );
        const first = await module.configuration.addPeriod(
          adminSession,
          parse(periodInput, {
            code: 'EVENT_A',
            kind: 'ONE_TIME',
            startsOn: '2026-11-05',
            endsOn: '2026-11-05',
            dueOn: '2026-11-10',
          }),
          audit,
        );
        const input = { periodId: first.id, flatIds: [flat], discounts: [] };
        const preview = await module.generation.preview(adminSession, input);
        await module.generation.generate(
          adminSession,
          { ...input, previewHash: preview.previewHash, idempotencyKey: 'one-time-event-12345' },
          audit,
        );
        await module.configuration.addConfiguration(
          adminSession,
          { ...base, chargeTypeId: charge.id, rate: '99.00' },
          audit,
        );
        const second = await module.configuration.addPeriod(
          adminSession,
          parse(periodInput, {
            code: 'EVENT_B',
            kind: 'ONE_TIME',
            startsOn: '2026-11-06',
            endsOn: '2026-11-06',
            dueOn: '2026-11-10',
          }),
          audit,
        );
        const repeated = await module.generation.preview(adminSession, {
          ...input,
          periodId: second.id,
        });
        assert.equal(repeated.flats[0]?.status, 'NO_CHARGES');
        assert.ok(repeated.flats[0]?.exclusions.some((e) => e.includes('already billed')));
      },
    );
    await suite.test(
      'failure after writing a bill rolls back the whole batch, snapshots and audit',
      async () => {
        const newPeriod = await module.configuration.addPeriod(
          adminSession,
          parse(periodInput, {
            code: 'ROLLBACK',
            kind: 'MONTHLY',
            startsOn: '2027-02-01',
            endsOn: '2027-02-28',
            dueOn: '2027-02-10',
          }),
          audit,
        );
        const input = { periodId: newPeriod.id, flatIds: [flat, String(a.flat)], discounts: [] };
        const preview = await module.generation.preview(adminSession, input);
        class FailingWriter extends BillWriter {
          private written = 0;
          override async write(...args: Parameters<BillWriter['write']>): Promise<string> {
            const id = await super.write(...args);
            if (++this.written === 2) throw new Error('Injected storage failure');
            return id;
          }
        }
        const failing = new BillingGeneration(access, undefined, new FailingWriter());
        const request: GenerationInput = {
          ...input,
          previewHash: preview.previewHash,
          idempotencyKey: 'rollback-batch-12345',
        };
        await assert.rejects(
          failing.generate(adminSession, request, audit),
          /Injected storage failure/,
        );
        const [runs] = await db.execute<RowDataPacket[]>(
          'SELECT id FROM billing_generation_runs WHERE society_id=? AND idempotency_key=?',
          [a.society, request.idempotencyKey],
        );
        assert.equal(runs.length, 0);
        const [bills] = await db.execute<RowDataPacket[]>(
          'SELECT id FROM bills WHERE society_id=? AND billing_period_id=?',
          [a.society, newPeriod.id],
        );
        assert.equal(bills.length, 0);
        const retry = await Promise.all([
          module.generation.generate(adminSession, request, audit),
          module.generation.generate(adminSession, request, audit),
        ]);
        assert.equal(retry[0]?.billCount, 2);
        assert.deepEqual(retry[0]?.billIds, retry[1]?.billIds);
        assert.equal(retry.filter((r) => r.replayed).length, 1);
      },
    );
    await suite.test(
      'lists paginate and issued details, flat references and configuration stay tenant scoped',
      async () => {
        assert.equal((await foreign.request('/society/billing/bills/' + issued)).status, 404);
        assert.equal(
          (
            await foreign.request('/society/billing/preview', {
              periodId,
              flatIds: [flat],
              discounts: [],
            })
          ).status,
          404,
        );
        const report = await committee.request('/society/billing/outstanding?pageSize=1');
        assert.equal(report.status, 200);
        assert.ok(Array.isArray(report.data['items']));
        assert.equal(report.data['items'].length, 1);
        assert.equal(report.headers.get('cache-control'), 'no-store');
        assert.equal((await committee.request('/society/billing/bills?sort=DROP')).status, 400);
        await assert.rejects(db.execute('DELETE FROM societies WHERE id=?', [a.society]), {
          code: 'ER_ROW_IS_REFERENCED_2',
        });
        await assert.rejects(
          db.execute('UPDATE billing_bill_details SET previous_outstanding=0 WHERE bill_id=?', [
            issued,
          ]),
          { code: 'ER_SIGNAL_EXCEPTION' },
        );
        assert.deepEqual(logs, []);
      },
    );
    await suite.test(
      'reversed payments restore outstanding and permission revocation defeats retained preview sessions',
      async () => {
        const before = await module.queries.detail(adminSession, String(a.bill));
        assert.equal(before.outstanding, '0.00');
        assert.match(before.issuedAt ?? '', /Z$/);
        await db.execute(
          'INSERT INTO payment_reversals(society_id,payment_id,reason,reversed_by_membership_id,idempotency_key) VALUES(?,?,?,?,?)',
          [
            a.society,
            a.payment,
            'Synthetic reversal verification',
            a.membership,
            'step7-reversal-12345',
          ],
        );
        const after = await module.queries.detail(adminSession, String(a.bill));
        assert.equal(after.paid, '0.00');
        assert.equal(after.outstanding, '100.25');
        await db.execute(
          "DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.society_id=? AND rp.role_id=? AND p.code='society.finance.read'",
          [a.society, a.role],
        );
        await assert.rejects(
          module.generation.preview(adminSession, { periodId, flatIds: [flat], discounts: [] }),
          { status: 403 },
        );
        assert.equal((await committee.request('/society/billing/bills')).status, 403);
      },
    );
  } finally {
    server.close();
    await once(server, 'close');
    await queue.idle();
    await database.pool.end();
  }
}
