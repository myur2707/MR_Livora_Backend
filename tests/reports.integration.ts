import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { parse as parseCsv } from 'csv-parse/sync';
import { createFixture, insert } from './fixtures.js';
import { grantTestRuntime } from './runtime-provision.js';
import { openRuntime } from '../src/database/runtime.js';
import { permissions, roleCapabilities, type TenantRole } from '../src/auth/types.js';
import { provisionReportPermissions } from '../src/database/report-permissions.js';
import { hashPassword } from '../src/auth/crypto.js';
import { AuthRepository } from '../src/auth/repository.js';
import { AuthService } from '../src/auth/service.js';
import { ResetQueue } from '../src/auth/reset-queue.js';
import { AuthClient } from './auth-client.js';
import { createApp } from '../src/http/app.js';
import { CommunityAccess } from '../src/community/access.js';
import { reportsModule } from '../src/reports/router.js';
import { reportKinds } from '../src/reports/contracts.js';
import { OnboardingRepository } from '../src/onboarding/repository.js';
import { OnboardingService } from '../src/onboarding/service.js';
import { InvitationService } from '../src/onboarding/invitations.js';
export async function reportsIntegration(suite: TestContext, db: Connection): Promise<void> {
  const password = 'Synthetic reports test password';
  let elapsed = 0;
  const clock = () => Date.parse('2026-10-05T06:30:00Z') + elapsed;
  for (const code of permissions)
    await db.execute(
      'INSERT INTO permissions(code,description) VALUES(?,?) ON DUPLICATE KEY UPDATE code=VALUES(code)',
      [code, code],
    );
  async function actor(name: string) {
    const person = await insert(db, 'INSERT INTO persons() VALUES()');
    const email = 'reports-' + name + '@example.invalid';
    const user = await insert(
      db,
      "INSERT INTO users(person_id,email_normalized,password_hash,status) VALUES(?,?,?,'ACTIVE')",
      [person, email, await hashPassword(password)],
    );
    return { person, user, email };
  }
  const admin = await actor('admin'),
    resident = await actor('resident'),
    accountant = await actor('accountant'),
    member = await actor('member'),
    platform = await actor('platform');
  const a = await createFixture(db, 'REPORT_A', admin.user, admin.person, 'COMMITTEE_ADMIN'),
    b = await createFixture(db, 'REPORT_B', admin.user, admin.person, 'COMMITTEE_ADMIN');
  for (const fixture of [a, b]) {
    await db.execute("UPDATE societies SET status='ACTIVE',timezone='Asia/Kolkata' WHERE id=?", [
      fixture.society,
    ]);
    await db.execute("UPDATE society_memberships SET joined_at='2026-09-01' WHERE id=?", [
      fixture.membership,
    ]);
    for (const code of roleCapabilities.COMMITTEE_ADMIN)
      await db.execute(
        'INSERT INTO role_permissions(society_id,role_id,permission_id) SELECT ?,?,id FROM permissions WHERE code=?',
        [fixture.society, fixture.role, code],
      );
  }
  async function membership(identity: typeof admin, role: TenantRole) {
    await db.execute(
      'INSERT INTO society_persons(society_id,person_id,display_name) VALUES(?,?,?)',
      [a.society, identity.person, role],
    );
    const id = await insert(
      db,
      "INSERT INTO society_memberships(society_id,user_id,status,joined_at) VALUES(?,?,'ACTIVE','2026-09-01')",
      [a.society, identity.user],
    );
    const roleId = await insert(db, 'INSERT INTO roles(society_id,code,name) VALUES(?,?,?)', [
      a.society,
      role,
      role,
    ]);
    await db.execute(
      'INSERT INTO membership_roles(society_id,membership_id,role_id) VALUES(?,?,?)',
      [a.society, id, roleId],
    );
    for (const code of role === 'RESIDENT' || role === 'COMMITTEE_MEMBER'
      ? permissions
      : roleCapabilities[role])
      await db.execute(
        'INSERT INTO role_permissions(society_id,role_id,permission_id) SELECT ?,?,id FROM permissions WHERE code=?',
        [a.society, roleId, code],
      );
    return id;
  }
  const residentMembership = await membership(resident, 'RESIDENT');
  await membership(accountant, 'ACCOUNTANT');
  await membership(member, 'COMMITTEE_MEMBER');
  await db.execute(
    "INSERT INTO platform_user_roles(user_id,role_code) VALUES(?,'PLATFORM_ADMIN')",
    [platform.user],
  );
  await provisionReportPermissions(db);
  await db.execute('UPDATE society_persons SET display_name=? WHERE society_id=? AND person_id=?', [
    ' =HYPERLINK("unsafe")',
    a.society,
    admin.person,
  ]);
  const noLogin = await insert(db, 'INSERT INTO persons() VALUES()');
  await db.execute(
    'INSERT INTO society_persons(society_id,person_id,display_name,contact_phone) VALUES(?,?,?,?)',
    [a.society, noLogin, 'No login, "quoted"\nlegacy name', '+1234567890'],
  );
  await db.execute(
    "UPDATE society_persons SET created_at='2026-10-03 01:00:00' WHERE society_id=?",
    [a.society],
  );
  for (const [name, created] of [
    ['Before local day', '2026-10-02 18:29:59.999999'],
    ['At local start', '2026-10-02 18:30:00.000000'],
    ['At local end', '2026-10-03 18:30:00.000000'],
    ['Before local end', '2026-10-03 18:29:59.999999'],
  ] as const) {
    const person = await insert(db, 'INSERT INTO persons() VALUES()');
    await db.execute(
      'INSERT INTO society_persons(society_id,person_id,display_name,created_at) VALUES(?,?,?,?)',
      [a.society, person, name, created],
    );
  }
  for (const [person, type, start, end] of [
    [admin.person, 'OWNER', '2026-09-01', null],
    [resident.person, 'TENANT', '2026-09-01', null],
    [noLogin, 'TENANT', '2026-01-01', '2026-08-31'],
    [noLogin, 'AUTHORIZED_OCCUPANT', '2026-11-01', null],
  ] as const)
    await db.execute(
      'INSERT INTO flat_occupancies(society_id,flat_id,person_id,occupancy_type,starts_on,ends_on) VALUES(?,?,?,?,?,?)',
      [a.society, a.flat, person, type, start, end],
    );
  await db.execute("INSERT INTO flats(society_id,building_id,flat_number) VALUES(?,?,'102')", [
    a.society,
    a.building,
  ]);
  const period = await insert(
    db,
    "INSERT INTO billing_periods(society_id,code,starts_on,ends_on,due_on) VALUES(?,'REPORT_ONE_TIME','2026-10-03','2026-10-03','2026-10-03')",
    [a.society],
  );
  const bill = await insert(
    db,
    "INSERT INTO bills(society_id,billing_period_id,flat_id,bill_number,total_amount) VALUES(?,?,?,'B-002',200.10)",
    [a.society, period, a.flat],
  );
  await db.execute(
    "INSERT INTO bill_items(society_id,bill_id,charge_configuration_id,line_number,description,quantity,unit_rate,amount) VALUES(?,?,?,1,'Report snapshot',1,200.10,200.10)",
    [a.society, bill, a.configuration],
  );
  await db.execute(
    "UPDATE bills SET status='ISSUED',issued_at='2026-10-03',issued_by_membership_id=? WHERE id=?",
    [a.membership, bill],
  );
  const [allocations] = await db.execute<RowDataPacket[]>(
    'SELECT id FROM payment_allocations WHERE payment_id=?',
    [a.payment],
  );
  const allocation: unknown = allocations[0]?.['id'];
  assert.ok(typeof allocation === 'number' || typeof allocation === 'string');
  const refund = await insert(
    db,
    "INSERT INTO payment_refunds(society_id,payment_id,amount,refund_date,method,reason,recorded_by_membership_id) VALUES(?,?,20.00,'2026-10-03','CASH','Synthetic test return',?)",
    [a.society, a.payment, a.membership],
  );
  await db.execute(
    'INSERT INTO payment_refund_allocations(society_id,refund_id,payment_id,allocation_id,bill_id,flat_id,amount) VALUES(?,?,?,?,?,?,20.00)',
    [a.society, refund, a.payment, allocation, a.bill, a.flat],
  );
  async function payment(amount: string, method: string, number: string) {
    const id = await insert(
      db,
      "INSERT INTO payments(society_id,flat_id,payer_person_id,method,payment_date,amount,reference,collected_by_membership_id,recorded_by_membership_id,idempotency_key) VALUES(?,?,?,?,'2026-10-03',?,?,?, ?,?)",
      [
        a.society,
        a.flat,
        admin.person,
        method,
        amount,
        'Report ' + number,
        a.membership,
        a.membership,
        'fixture-report-payment-' + number,
      ],
    );
    await db.execute(
      'INSERT INTO payment_allocations(society_id,payment_id,bill_id,flat_id,amount) VALUES(?,?,?,?,?)',
      [a.society, id, bill, a.flat, amount],
    );
    await db.execute(
      'INSERT INTO receipts(society_id,payment_id,receipt_number,issued_at,issued_by_membership_id) VALUES(?,?,?,UTC_TIMESTAMP(6),?)',
      [a.society, id, number, a.membership],
    );
    return id;
  }
  const reversed = await payment('20.05', 'CASH', 'R-002'),
    reversal = await insert(
      db,
      "INSERT INTO payment_reversals(society_id,payment_id,reason,reversed_by_membership_id,idempotency_key) VALUES(?,?,'Synthetic reversal',?,'fixture-report-reversal-1')",
      [a.society, reversed, a.membership],
    );
  await db.execute(
    "INSERT INTO payment_reversal_details(society_id,reversal_id,operation_date) VALUES(?,?,'2026-10-04')",
    [a.society, reversal],
  );
  await payment('30.10', 'UPI', 'R-003');
  const notice = await insert(
    db,
    "INSERT INTO notices(society_id,title,body,status,published_at,created_by_membership_id) VALUES(?,'Report published notice','Plain','PUBLISHED','2026-10-03',?)",
    [a.society, a.membership],
  );
  await db.execute(
    "INSERT INTO notices(society_id,title,body,created_by_membership_id) VALUES(?,'Private draft','Private',?)",
    [a.society, a.membership],
  );
  await db.execute(
    "INSERT INTO complaints(society_id,submitted_by_membership_id,flat_id,title,description) VALUES(?,?,?,'Open report complaint','Private')",
    [a.society, residentMembership, a.flat],
  );
  await grantTestRuntime();
  const database = await openRuntime(process.env),
    queue = new ResetQueue(() => undefined);
  const auth = await AuthService.create(
    new AuthRepository(database),
    {
      origin: 'http://127.0.0.1:4200',
      secret: 'f'.repeat(64),
      secure: false,
      cookieName: 'livora_session',
      idleMs: 1800000,
      absoluteMs: 43200000,
      resetMs: 1800000,
    },
    { send: () => Promise.resolve() },
    queue,
    clock,
  );
  const onboarding = new OnboardingService(new OnboardingRepository(database, clock));
  const logs: string[] = [];
  const server = createApp(
    auth,
    (code) => logs.push(code),
    undefined,
    {
      service: onboarding,
      invitations: new InvitationService(
        onboarding,
        auth.config.origin,
        { send: () => Promise.resolve() },
        queue,
      ),
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    reportsModule(new CommunityAccess(database, clock)),
  ).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = 'http://127.0.0.1:' + address.port;
  function client() {
    const value = new AuthClient(baseUrl, auth.config.origin),
      request = value.request.bind(value);
    value.request = async (...args: Parameters<AuthClient['request']>) => {
      await delay(550);
      return request(...args);
    };
    return value;
  }
  const committee = client(),
    r = client(),
    acc = client(),
    cm = client(),
    p = client(),
    anonymous = client();
  const base = '/society/reports';
  try {
    for (const [value, identity] of [
      [committee, admin],
      [r, resident],
      [acc, accountant],
      [cm, member],
      [p, platform],
    ] as const) {
      await value.login(identity.email, password);
      if (value !== p)
        assert.equal(
          (await value.request('/auth/society-context', { societyId: String(a.society) })).status,
          204,
        );
    }
    await suite.test(
      'all seven reports paginate tenant data with exact full-filter totals',
      async () => {
        for (const kind of reportKinds) {
          const report = await committee.request(base + '/' + kind + '?pageSize=1');
          assert.equal(report.status, 200, kind);
          assert.ok(Array.isArray(report.data['items']));
          assert.equal(report.data['items'].length, 1);
          assert.equal(report.headers.get('cache-control'), 'no-store');
        }
        const billing = await committee.request(base + '/billing?pageSize=1'),
          second = await committee.request(base + '/billing?pageSize=1&page=2');
        assert.deepEqual(billing.data['summary'], {
          billed: '300.35',
          credits: '0.00',
          paid: '110.35',
          outstanding: '190.00',
          creditBalance: '0.00',
        });
        assert.deepEqual(second.data['summary'], billing.data['summary']);
        assert.equal(billing.data['total'], 2);
        const payments = await committee.request(base + '/payments');
        assert.deepEqual(payments.data['summary'], {
          totalRecorded: '150.40',
          refunds: '20.00',
          reversals: '20.05',
          netRecorded: '110.35',
        });
        const collection = await committee.request(base + '/collection');
        assert.deepEqual(collection.data['summary'], {
          collections: '150.40',
          refunds: '20.00',
          reversals: '20.05',
          netRecorded: '110.35',
        });
        const cash = await committee.request(base + '/cash-collection');
        assert.deepEqual(cash.data['summary'], {
          collections: '120.30',
          refunds: '20.00',
          reversals: '20.05',
          netRecorded: '80.25',
        });
      },
    );
    await suite.test(
      'date filters use event dates and society-local creation boundaries',
      async () => {
        const day = await committee.request(base + '/collection?from=2026-10-03&to=2026-10-03');
        assert.deepEqual(day.data['summary'], {
          collections: '50.15',
          refunds: '20.00',
          reversals: '0.00',
          netRecorded: '30.15',
        });
        const last = await committee.request(base + '/collection?from=2026-10-04&to=2026-10-04');
        assert.deepEqual(last.data['summary'], {
          collections: '0.00',
          refunds: '0.00',
          reversals: '20.05',
          netRecorded: '-20.05',
        });
        const people = await committee.request(base + '/residents?from=2026-10-03&to=2026-10-03');
        assert.equal(people.status, 200);
        assert.ok(people.raw.includes('At local start'));
        assert.ok(people.raw.includes('Before local end'));
        assert.ok(!people.raw.includes('Before local day'));
        assert.ok(!people.raw.includes('At local end'));
        assert.equal(
          (await committee.request(base + '/billing?from=2026-10-03&to=2026-10-03')).data['total'],
          1,
        );
        assert.equal(
          (await committee.request(base + '/flat-occupancy?from=2026-10-03&to=2026-10-03')).data[
            'total'
          ],
          2,
        );
      },
    );
    await suite.test(
      'allowlisted filters/sorts, scoped references and occupancy states are enforced',
      async () => {
        assert.equal(
          (await committee.request(base + '/billing?q=B-001&sort=amount&direction=ASC')).data[
            'total'
          ],
          1,
        );
        assert.equal((await committee.request(base + '/billing?status=OVERDUE')).data['total'], 1);
        assert.equal(
          (await committee.request(base + '/flat-occupancy?status=CURRENT&occupancyType=TENANT'))
            .data['total'],
          1,
        );
        assert.equal(
          (await committee.request(base + '/flat-occupancy?status=ENDED')).data['total'],
          1,
        );
        assert.equal(
          (await committee.request(base + '/flat-occupancy?status=FUTURE')).data['total'],
          1,
        );
        assert.equal(
          (await committee.request(base + '/cash-collection?collectorUserId=' + admin.user)).data[
            'total'
          ],
          4,
        );
        for (const query of [
          'buildingId=' + b.building,
          'flatId=' + b.flat,
          'periodId=' + b.period,
        ])
          assert.equal((await committee.request(base + '/billing?' + query)).status, 404);
        assert.equal(
          (await committee.request(base + '/collection?collectorUserId=' + platform.user)).status,
          404,
        );
        for (const query of [
          'societyId=' + b.society,
          'sort=SQL',
          'pageSize=51',
          'from=2026-02-30&to=2026-03-01',
          'from=2026-10-03',
          'from=2026-10-04&to=2026-10-03',
          'method=CASH',
        ])
          assert.equal((await committee.request(base + '/billing?' + query)).status, 400);
      },
    );
    await suite.test(
      'committee dashboard matches bills, ledger and current occupancy without private directory data',
      async () => {
        const result = await committee.request('/society/dashboard');
        assert.equal(result.status, 200);
        assert.equal(result.data['flats'], 2);
        assert.equal(result.data['pendingComplaints'], 1);
        assert.deepEqual(result.data['occupancy'], {
          occupiedFlats: 1,
          occupancies: 2,
          persons: 2,
          types: [
            { type: 'OWNER', total: 1 },
            { type: 'TENANT', total: 1 },
          ],
        });
        const finance = result.data['finance'];
        assert.ok(
          typeof finance === 'object' &&
            finance !== null &&
            'billing' in finance &&
            'collections' in finance &&
            'cash' in finance,
        );
        assert.deepEqual(finance.billing, {
          billed: '300.35',
          credits: '0.00',
          paid: '110.35',
          outstanding: '190.00',
          creditBalance: '0.00',
        });
        assert.deepEqual(finance.collections, {
          collections: '150.40',
          refunds: '20.00',
          reversals: '20.05',
          netRecorded: '110.35',
        });
        assert.deepEqual(finance.cash, {
          collections: '120.30',
          refunds: '20.00',
          reversals: '20.05',
          netRecorded: '80.25',
        });
        assert.ok(Array.isArray(result.data['recentNotices']));
        assert.equal(result.data['recentNotices'].length, 1);
        const firstNotice: unknown = result.data['recentNotices'][0];
        assert.ok(typeof firstNotice === 'object' && firstNotice !== null && 'id' in firstNotice);
        assert.equal(firstNotice.id, String(notice));
        assert.ok(!result.raw.includes('Private draft'));
        assert.ok(!result.raw.includes('contactEmail'));
        const limited = await cm.request('/society/dashboard');
        assert.equal(limited.status, 200);
        assert.equal(limited.data['finance'], null);
      },
    );
    await suite.test(
      'roles and platform metadata prevent financial/resident data bypass',
      async () => {
        for (const value of [r, cm, p]) {
          assert.equal((await value.request(base + '/payments')).status, 403);
          assert.equal((await value.request(base + '/residents')).status, 403);
          assert.equal((await value.request(base + '/payments/export')).status, 403);
        }
        assert.equal((await anonymous.request(base + '/billing')).status, 401);
        assert.equal((await r.request('/society/dashboard')).status, 403);
        assert.equal((await acc.request(base + '/billing')).status, 200);
        assert.equal((await acc.request(base + '/residents')).status, 403);
        assert.equal((await acc.request(base + '/residents/export')).status, 403);
        const dashboard = await p.request('/platform/dashboard');
        assert.equal(dashboard.status, 200);
        assert.deepEqual(Object.keys(dashboard.data), [
          'statuses',
          'totalSocieties',
          'pendingVerification',
          'updatedAt',
        ]);
        const [counts] = await db.execute<RowDataPacket[]>(
          'SELECT COUNT(*) AS total FROM societies WHERE archived_at IS NULL',
        );
        assert.equal(dashboard.data['totalSocieties'], Number(counts[0]?.['total']));
        assert.ok(!dashboard.raw.includes('REPORT_A'));
        assert.ok(!dashboard.raw.includes('outstanding'));
        assert.equal((await p.request('/society/dashboard')).status, 403);
      },
    );
    await suite.test(
      'CSV exports neutralize formulas/escaping, include all matches and audit authorized actor',
      async () => {
        const exported = await committee.request(base + '/residents/export');
        assert.equal(exported.status, 200);
        assert.match(exported.headers.get('content-type') ?? '', /^text\/csv/);
        assert.match(exported.headers.get('content-disposition') ?? '', /livora-residents\.csv/);
        assert.equal(exported.headers.get('cache-control'), 'no-store');
        const records: unknown = parseCsv(exported.raw, { bom: true, columns: true });
        assert.ok(Array.isArray(records));
        assert.ok(
          records.some(
            (record: unknown) =>
              typeof record === 'object' &&
              record !== null &&
              'Resident' in record &&
              record.Resident === '\' =HYPERLINK("unsafe")',
          ),
        );
        assert.ok(
          records.some(
            (record: unknown) =>
              typeof record === 'object' &&
              record !== null &&
              'Resident' in record &&
              record.Resident === 'No login, "quoted"\nlegacy name',
          ),
        );
        const paymentCsv = await committee.request(base + '/payments/export?pageSize=1&page=2');
        assert.equal(paymentCsv.status, 200);
        const entries: unknown = parseCsv(paymentCsv.raw, { bom: true, columns: true });
        assert.ok(Array.isArray(entries));
        assert.equal(entries.length, 3);
        const [events] = await db.execute<RowDataPacket[]>(
          "SELECT actor_user_id,safe_metadata FROM audit_logs WHERE society_id=? AND action='report.exported' ORDER BY id",
          [a.society],
        );
        assert.equal(events.length, 2);
        assert.ok(events.every((event) => Number(event['actor_user_id']) === admin.user));
        assert.ok(!JSON.stringify(events).includes('HYPERLINK'));
        await db.execute(
          "DELETE rp FROM role_permissions rp JOIN permissions permission ON permission.id=rp.permission_id WHERE rp.society_id=? AND rp.role_id=? AND permission.code='society.reports.export'",
          [a.society, a.role],
        );
        assert.equal((await committee.request(base + '/billing/export')).status, 403);
        assert.equal((await committee.request(base + '/billing')).status, 200);
        await db.execute(
          "INSERT INTO role_permissions(society_id,role_id,permission_id) SELECT ?,?,id FROM permissions WHERE code='society.reports.export'",
          [a.society, a.role],
        );
      },
    );
    await suite.test(
      'society switching, stale identifiers and suspended membership fail closed',
      async () => {
        assert.equal(
          (await committee.request('/auth/society-context', { societyId: String(b.society) }))
            .status,
          204,
        );
        const report = await committee.request(base + '/billing');
        assert.deepEqual(report.data['summary'], {
          billed: '100.25',
          credits: '0.00',
          paid: '100.25',
          outstanding: '0.00',
          creditBalance: '0.00',
        });
        assert.equal((await committee.request(base + '/billing?flatId=' + a.flat)).status, 404);
        assert.equal(
          (await committee.request('/auth/society-context', { societyId: String(a.society) }))
            .status,
          204,
        );
        await db.execute("UPDATE society_memberships SET status='SUSPENDED' WHERE id=?", [
          a.membership,
        ]);
        assert.equal((await committee.request(base + '/billing')).status, 403);
        assert.equal((await committee.request(base + '/residents/export')).status, 403);
        await db.execute("UPDATE society_memberships SET status='ACTIVE' WHERE id=?", [
          a.membership,
        ]);
      },
    );
    await suite.test(
      'bounded exports reject oversized matches without truncation or audit success',
      async () => {
        const baseDate = Date.parse('2000-01-01');
        for (let batch = 0; batch < 6; batch++) {
          const size = Math.min(1000, 5001 - batch * 1000);
          if (size <= 0) break;
          const values: (string | number)[] = [];
          for (let index = 0; index < size; index++) {
            const date = new Date(baseDate + (batch * 1000 + index) * 86400000)
              .toISOString()
              .slice(0, 10);
            values.push(a.society, a.flat, admin.person, 'AUTHORIZED_OCCUPANT', date, date);
          }
          await db.execute(
            'INSERT INTO flat_occupancies(society_id,flat_id,person_id,occupancy_type,starts_on,ends_on) VALUES ' +
              Array.from({ length: size }, () => '(?,?,?,?,?,?)').join(','),
            values,
          );
        }
        const result = await committee.request(base + '/flat-occupancy/export');
        assert.equal(result.status, 422);
        assert.equal((result.data['error'] as Record<string, unknown>)['code'], 'EXPORT_TOO_LARGE');
        assert.equal(
          (await committee.request(base + '/flat-occupancy?status=CURRENT&pageSize=1')).data[
            'total'
          ],
          2,
        );
      },
    );
    await suite.test(
      'export abuse is rate limited and API internal errors stay absent',
      async () => {
        elapsed += 900001;
        for (let index = 0; index < 10; index++)
          assert.equal((await committee.request(base + '/payments/export')).status, 200);
        assert.equal((await committee.request(base + '/payments/export')).status, 429);
        assert.deepEqual(logs, []);
      },
    );
  } finally {
    await queue.idle();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await database.pool.end();
  }
}
