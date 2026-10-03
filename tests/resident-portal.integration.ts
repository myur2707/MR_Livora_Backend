import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { createFixture, insert } from './fixtures.js';
import { grantTestRuntime } from './runtime-provision.js';
import { openRuntime } from '../src/database/runtime.js';
import { hashPassword } from '../src/auth/crypto.js';
import { AuthRepository } from '../src/auth/repository.js';
import { AuthService } from '../src/auth/service.js';
import { ResetQueue } from '../src/auth/reset-queue.js';
import { AuthClient } from './auth-client.js';
import { createApp } from '../src/http/app.js';
import { ResidentAccess } from '../src/resident-portal/access.js';
import { residentPortalModule } from '../src/resident-portal/router.js';
import { BillingAccess } from '../src/billing/access.js';
import { billingModule } from '../src/billing/router.js';
import { PropertyAccess } from '../src/property/access.js';
import { PropertyService } from '../src/property/service.js';
import { OccupancyService } from '../src/property/occupancies.js';
import { ImportService } from '../src/property/imports/service.js';
export async function residentPortalIntegration(suite: TestContext, db: Connection): Promise<void> {
  const password = 'Synthetic resident portal password';
  const person = await insert(db, 'INSERT INTO persons() VALUES()');
  const user = await insert(
    db,
    "INSERT INTO users(person_id,email_normalized,password_hash,status) VALUES(?,?,?,'ACTIVE')",
    [person, 'portal@example.invalid', await hashPassword(password)],
  );
  const a = await createFixture(db, 'PORTAL_A', user, person, 'RESIDENT');
  const b = await createFixture(db, 'PORTAL_B', user, person, 'COMMITTEE_MEMBER');
  const strangerPerson = await insert(db, 'INSERT INTO persons() VALUES()');
  const stranger = await insert(
    db,
    "INSERT INTO users(person_id,email_normalized,password_hash,status) VALUES(?,?,?,'ACTIVE')",
    [strangerPerson, 'portal-other@example.invalid', await hashPassword(password)],
  );
  await db.execute(
    'INSERT INTO society_persons(society_id,person_id,display_name,contact_phone) VALUES(?,?,?,?)',
    [a.society, strangerPerson, 'Private other resident', 'private-contact'],
  );
  const otherMembership = await insert(
    db,
    "INSERT INTO society_memberships(society_id,user_id,status,joined_at) VALUES(?,?,'ACTIVE',UTC_TIMESTAMP(6))",
    [a.society, stranger],
  );
  await db.execute('INSERT INTO membership_roles(society_id,membership_id,role_id) VALUES(?,?,?)', [
    a.society,
    otherMembership,
    a.role,
  ]);
  for (const f of [a, b]) {
    await db.execute("UPDATE societies SET status='ACTIVE' WHERE id=?", [f.society]);
    await db.execute(
      "INSERT INTO role_permissions(society_id,role_id,permission_id) SELECT ?,?,id FROM permissions WHERE code IN ('society.dashboard.read','society.finance.read')",
      [f.society, f.role],
    );
    await db.execute(
      "INSERT INTO flat_occupancies(society_id,flat_id,person_id,occupancy_type,starts_on) VALUES(?,?,?,'OWNER','2026-09-01')",
      [f.society, f.flat, person],
    );
  }
  await db.execute(
    "UPDATE society_persons SET display_name='My A profile',contact_phone='my-contact' WHERE society_id=? AND person_id=?",
    [a.society, person],
  );
  await db.execute(
    "UPDATE society_persons SET display_name='My B profile' WHERE society_id=? AND person_id=?",
    [b.society, person],
  );
  async function flat(number: string, type: string, starts: string, ends: string | null = null) {
    const id = await insert(
      db,
      'INSERT INTO flats(society_id,building_id,flat_number) VALUES(?,?,?)',
      [a.society, a.building, number],
    );
    await db.execute(
      'INSERT INTO flat_occupancies(society_id,flat_id,person_id,occupancy_type,starts_on,ends_on) VALUES(?,?,?,?,?,?)',
      [a.society, id, person, type, starts, ends],
    );
    return id;
  }
  const second = await flat('102', 'TENANT', '2026-09-20');
  const historical = await flat('103', 'FAMILY_MEMBER', '2026-09-01', '2026-10-02');
  const future = await flat('104', 'AUTHORIZED_OCCUPANT', '2026-10-04');
  let sequence = 0;
  async function bill(flatId: number, date: string, due: string, amount: string, issued = true) {
    const period = await insert(
      db,
      'INSERT INTO billing_periods(society_id,code,starts_on,ends_on,due_on) VALUES(?,?,?,?,?)',
      [a.society, 'PORTAL_' + ++sequence, date, date, due],
    );
    const id = await insert(
      db,
      'INSERT INTO bills(society_id,billing_period_id,flat_id,bill_number,total_amount) VALUES(?,?,?,?,?)',
      [a.society, period, flatId, 'PORTAL_' + sequence, amount],
    );
    await db.execute(
      "INSERT INTO bill_items(society_id,bill_id,charge_configuration_id,line_number,description,quantity,unit_rate,amount) VALUES(?,?,?,1,'Authorized bill item',1,?,?)",
      [a.society, id, a.configuration, amount, amount],
    );
    if (issued)
      await db.execute(
        "UPDATE bills SET status='ISSUED',issued_at=UTC_TIMESTAMP(6),issued_by_membership_id=? WHERE id=?",
        [a.membership, id],
      );
    return id;
  }
  const overdue = await bill(a.flat, '2026-10-01', '2026-10-01', '10.00');
  const current = await bill(second, '2026-10-02', '2026-10-20', '5.22');
  const earlier = await bill(a.flat, '2026-08-01', '2026-08-10', '999.99');
  const futureBill = await bill(future, '2026-10-03', '2026-10-20', '40.00');
  const historicalBill = await bill(historical, '2026-09-01', '2026-09-10', '40.00');
  const draft = await bill(second, '2026-10-04', '2026-10-20', '40.00', false);
  const otherPayment = await insert(
    db,
    "INSERT INTO payments(society_id,flat_id,payer_person_id,method,payment_date,amount,collected_by_membership_id,recorded_by_membership_id,idempotency_key) VALUES(?,?,?,'CASH','2026-10-02','2.00',?,?,'portal-other-payment')",
    [a.society, a.flat, strangerPerson, a.membership, a.membership],
  );
  await db.execute(
    'INSERT INTO payment_allocations(society_id,payment_id,bill_id,flat_id,amount) VALUES(?,?,?,?,2.00)',
    [a.society, otherPayment, overdue, a.flat],
  );
  await db.execute(
    "INSERT INTO receipts(society_id,payment_id,receipt_number,issued_at,issued_by_membership_id) VALUES(?,?,'R-OTHER',UTC_TIMESTAMP(6),?)",
    [a.society, otherPayment, a.membership],
  );
  const published = await insert(
    db,
    "INSERT INTO notices(society_id,title,body,status,published_at,created_by_membership_id) VALUES(?,'Published notice','Plain notice text','PUBLISHED',UTC_TIMESTAMP(6),?)",
    [a.society, a.membership],
  );
  const hiddenNotice = await insert(
    db,
    "INSERT INTO notices(society_id,title,body,created_by_membership_id) VALUES(?,'Private draft','Hidden',?)",
    [a.society, a.membership],
  );
  const futureNotice = await insert(
    db,
    "INSERT INTO notices(society_id,title,body,status,published_at,created_by_membership_id) VALUES(?,'Future notice','Hidden','PUBLISHED','2099-01-01',?)",
    [a.society, a.membership],
  );
  const otherComplaint = await insert(
    db,
    "INSERT INTO complaints(society_id,submitted_by_membership_id,flat_id,title,description) VALUES(?,?,?,'Private complaint','Private other complaint text')",
    [a.society, otherMembership, a.flat],
  );
  await grantTestRuntime();
  const database = await openRuntime(process.env);
  let elapsed = 0;
  const clock = () => Date.now() + elapsed;
  const queue = new ResetQueue(() => undefined);
  const auth = await AuthService.create(
    new AuthRepository(database),
    {
      origin: 'http://127.0.0.1:4200',
      secret: '9'.repeat(64),
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
  const module = residentPortalModule(new ResidentAccess(database, clock));
  const service = new PropertyService(new PropertyAccess(database, clock));
  const occupancy = new OccupancyService(service);
  const logs: string[] = [];
  const server = createApp(
    auth,
    (code) => logs.push(code),
    undefined,
    undefined,
    { service, occupancy, imports: new ImportService(service, occupancy) },
    undefined,
    billingModule(new BillingAccess(database, clock)),
    undefined,
    module,
  ).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = new AuthClient('http://127.0.0.1:' + address.port, auth.config.origin);
  const anonymous = new AuthClient(client.base, auth.config.origin);
  const request = client.request.bind(client);
  client.request = async (...args: Parameters<AuthClient['request']>) => {
    await delay(550);
    return request(...args);
  };
  const base = '/society/resident';
  let complaintId = '';
  try {
    await client.login('portal@example.invalid', password);
    assert.equal(
      (await client.request('/auth/society-context', { societyId: String(a.society) })).status,
      204,
    );
    const session = await auth.readSession(client.cookie.split('=')[1] ?? '');
    assert.ok(session);
    await suite.test(
      'multiple current flats are private, paginated, and exclude historical/future occupancy',
      async () => {
        const result = await client.request(base + '/flats?pageSize=1');
        assert.equal(result.status, 200);
        assert.equal(result.data['total'], 2);
        const all = await client.request(base + '/flats');
        assert.ok(Array.isArray(all.data['items']));
        assert.equal(all.data['items'].length, 2);
        for (const id of [a.flat, second])
          assert.equal((await client.request(base + '/flats/' + id)).status, 200);
        for (const id of [historical, future, b.flat])
          assert.equal((await client.request(base + '/flats/' + id)).status, 404);
        assert.doesNotMatch(all.raw, /Private other|private-contact|personId|contactPhone/);
        assert.equal(
          (await client.request(base + '/flats?personId=' + strangerPerson)).status,
          400,
        );
        assert.equal((await client.request(base + '/flats?pageSize=51')).status, 400);
      },
    );
    await suite.test(
      'bills require current occupancy and period-start eligibility; summaries reconcile exactly',
      async () => {
        const result = await client.request(base + '/bills');
        assert.equal(result.status, 200);
        assert.equal(result.data['total'], 3);
        for (const id of [a.bill, current, overdue])
          assert.equal((await client.request(base + '/bills/' + id)).status, 200);
        for (const id of [earlier, futureBill, historicalBill, draft, b.bill])
          assert.equal((await client.request(base + '/bills/' + id)).status, 404);
        assert.equal((await client.request(base + '/bills?flatId=' + b.flat)).status, 404);
        assert.equal((await client.request(base + '/bills?status=OUTSTANDING')).data['total'], 2);
        const dashboard = await client.request(base + '/dashboard');
        assert.equal(dashboard.status, 200);
        assert.equal(dashboard.data['currentDue'], '5.22');
        assert.equal(dashboard.data['overdue'], '8.00');
        assert.doesNotMatch(dashboard.raw, /Private other|private-contact|collectedBy|recordedBy/);
      },
    );
    await suite.test(
      'own receipts remain accessible; another payer in the same flat and society is denied',
      async () => {
        const history = await client.request(base + '/payments');
        assert.equal(history.status, 200);
        assert.equal(history.data['total'], 1);
        const receipt = await client.request(base + '/payments/' + a.payment + '/receipt');
        assert.equal(receipt.status, 200);
        assert.equal(receipt.data['receiptNumber'], 'R-001');
        assert.equal(receipt.data['amount'], '100.25');
        assert.equal(receipt.headers.get('cache-control'), 'no-store');
        assert.doesNotMatch(
          receipt.raw,
          /collectedBy|recordedBy|collectorName|recorderName|personId|notes/,
        );
        for (const id of [otherPayment, b.payment])
          assert.equal((await client.request(base + '/payments/' + id + '/receipt')).status, 404);
        await db.execute(
          "UPDATE flat_occupancies SET ends_on='2026-10-02' WHERE society_id=? AND flat_id=? AND person_id=?",
          [a.society, a.flat, person],
        );
        assert.equal((await client.request(base + '/bills/' + a.bill)).status, 404);
        assert.equal(
          (await client.request(base + '/payments/' + a.payment + '/receipt')).status,
          200,
        );
      },
    );
    await suite.test(
      'published notices and complaint ownership enforce server-side scope, CSRF and mass assignment',
      async () => {
        const feed = await client.request(base + '/notices');
        assert.equal(feed.status, 200);
        assert.equal(feed.data['total'], 1);
        assert.equal((await client.request(base + '/notices/' + published)).status, 200);
        for (const id of [hiddenNotice, futureNotice])
          assert.equal((await client.request(base + '/notices/' + id)).status, 404);
        const fields = {
          flatId: String(second),
          title: 'A repair request',
          description: 'First line\nSecond line',
        };
        for (const extra of [
          { societyId: String(b.society) },
          { submittedByMembershipId: String(otherMembership) },
          { status: 'RESOLVED' },
        ])
          assert.equal(
            (await client.request(base + '/complaints', { ...fields, ...extra })).status,
            400,
          );
        assert.equal(
          (await client.request(base + '/complaints', fields, { 'X-CSRF-Token': 'wrong' })).status,
          403,
        );
        for (const flatId of [b.flat, future, historical, a.flat])
          assert.equal(
            (await client.request(base + '/complaints', { ...fields, flatId: String(flatId) }))
              .status,
            404,
          );
        const submitted = await client.request(base + '/complaints', fields);
        assert.equal(submitted.status, 201);
        complaintId = String(submitted.data['id']);
        assert.equal((await client.request(base + '/complaints')).data['total'], 1);
        assert.equal((await client.request(base + '/complaints/' + complaintId)).status, 200);
        assert.equal((await client.request(base + '/complaints/' + otherComplaint)).status, 404);
        const [audits] = await db.query<RowDataPacket[]>(
          "SELECT actor_user_id,safe_metadata FROM audit_logs WHERE society_id=? AND action='complaint.submitted'",
          [a.society],
        );
        assert.equal(audits.length, 1);
        assert.equal(String(audits[0]?.['actor_user_id']), String(user));
        assert.doesNotMatch(
          (await client.request(base + '/complaints')).raw,
          /Private other complaint|submittedBy|userId/,
        );
      },
    );
    await suite.test(
      'society switching validates membership, different roles, resources and stale request context',
      async () => {
        assert.equal(
          (await client.request('/auth/society-context', { societyId: '999999999' })).status,
          403,
        );
        assert.equal(
          (await client.request('/auth/society-context', { societyId: String(b.society) })).status,
          204,
        );
        assert.equal((await client.request(base + '/profile')).data['displayName'], 'My B profile');
        assert.equal((await client.request(base + '/flats')).data['total'], 1);
        for (const path of [
          '/bills/' + a.bill,
          '/payments/' + a.payment + '/receipt',
          '/complaints/' + complaintId,
          '/notices/' + published,
        ])
          assert.equal((await client.request(base + path)).status, 404);
        assert.equal((await client.request(base + '/bills/' + b.bill)).status, 200);
        await assert.rejects(module.bills.detail(session, String(a.bill)), {
          code: 'CONTEXT_CHANGED',
        });
        assert.equal((await client.request(base + '/bills?societyId=' + a.society)).status, 400);
        assert.equal(
          (await client.request('/auth/society-context', { societyId: null })).status,
          204,
        );
        assert.equal((await client.request(base + '/dashboard')).status, 403);
        assert.equal(
          (await client.request('/auth/society-context', { societyId: String(a.society) })).status,
          204,
        );
      },
    );
    await suite.test(
      'membership revocation and committee-only APIs fail closed; verified person link supersedes global person',
      async () => {
        for (const path of ['/society/billing/bills', '/society/persons', '/platform/access'])
          assert.equal((await client.request(path)).status, 403);
        await db.execute("UPDATE society_memberships SET status='SUSPENDED' WHERE id=?", [
          a.membership,
        ]);
        assert.equal((await client.request(base + '/payments')).status, 403);
        await db.execute("UPDATE society_memberships SET status='ACTIVE' WHERE id=?", [
          a.membership,
        ]);
        const linked = await insert(db, 'INSERT INTO persons() VALUES()');
        await db.execute(
          "INSERT INTO society_persons(society_id,person_id,display_name) VALUES(?,?,'Verified linked profile')",
          [a.society, linked],
        );
        await db.execute(
          'INSERT INTO membership_person_links(society_id,membership_id,person_id) VALUES(?,?,?)',
          [a.society, a.membership, linked],
        );
        assert.equal(
          (await client.request(base + '/profile')).data['displayName'],
          'Verified linked profile',
        );
        assert.equal((await client.request(base + '/flats')).data['total'], 0);
        assert.equal(
          (await client.request(base + '/payments/' + a.payment + '/receipt')).status,
          404,
        );
        assert.equal((await client.request(base + '/complaints/' + complaintId)).status, 200);
      },
    );
    await suite.test(
      'expired sessions, anonymous requests and archived linked people reveal no private records',
      async () => {
        assert.equal((await anonymous.request(base + '/profile')).status, 401);
        await db.execute(
          'UPDATE society_persons sp JOIN membership_person_links l ON l.society_id=sp.society_id AND l.person_id=sp.person_id SET sp.archived_at=UTC_TIMESTAMP(6) WHERE l.membership_id=?',
          [a.membership],
        );
        assert.equal((await client.request(base + '/profile')).status, 403);
        elapsed = 1800001;
        assert.equal(
          (await client.request(base + '/payments/' + a.payment + '/receipt')).status,
          401,
        );
        assert.deepEqual(logs, []);
      },
    );
  } finally {
    server.close();
    await once(server, 'close');
    await queue.idle();
    await database.pool.end();
  }
}
