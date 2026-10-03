import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { createFixture, insert } from './fixtures.js';
import { grantTestRuntime } from './runtime-provision.js';
import { openRuntime } from '../src/database/runtime.js';
import { provisionCommunityPermissions } from '../src/database/community-grants.js';
import { hashPassword } from '../src/auth/crypto.js';
import { AuthRepository } from '../src/auth/repository.js';
import { AuthService } from '../src/auth/service.js';
import { ResetQueue } from '../src/auth/reset-queue.js';
import { AuthClient } from './auth-client.js';
import { createApp } from '../src/http/app.js';
import { CommunityAccess } from '../src/community/access.js';
import { communityModule } from '../src/community/router.js';
import { ResidentAccess } from '../src/resident-portal/access.js';
import { residentPortalModule } from '../src/resident-portal/router.js';
export async function communityIntegration(suite: TestContext, db: Connection): Promise<void> {
  await db.execute(
    "INSERT INTO permissions(code,description) VALUES('society.dashboard.read','Dashboard') ON DUPLICATE KEY UPDATE code=VALUES(code)",
  );
  const password = 'Synthetic community test password';
  const clock = () => Date.parse('2026-10-03T06:30:00Z');
  async function actor(email: string) {
    const person = await insert(db, 'INSERT INTO persons() VALUES()');
    const user = await insert(
      db,
      "INSERT INTO users(person_id,email_normalized,password_hash,status) VALUES(?,?,?,'ACTIVE')",
      [person, email, await hashPassword(password)],
    );
    return { person, user };
  }
  const admin = await actor('community-admin@example.invalid');
  const resident = await actor('community-resident@example.invalid');
  const a = await createFixture(db, 'COMMUNITY_A', admin.user, admin.person, 'COMMITTEE_ADMIN');
  const b = await createFixture(db, 'COMMUNITY_B', admin.user, admin.person, 'COMMITTEE_MEMBER');
  for (const fixture of [a, b]) {
    await db.execute("UPDATE societies SET status='ACTIVE' WHERE id=?", [fixture.society]);
    await db.execute("UPDATE society_memberships SET joined_at='2026-09-01' WHERE id=?", [
      fixture.membership,
    ]);
    await db.execute(
      "INSERT INTO role_permissions(society_id,role_id,permission_id) SELECT ?,?,id FROM permissions WHERE code='society.dashboard.read'",
      [fixture.society, fixture.role],
    );
  }
  await provisionCommunityPermissions(db);
  await db.execute(
    "INSERT INTO society_persons(society_id,person_id,display_name) VALUES(?,?,'Private resident')",
    [a.society, resident.person],
  );
  const membership = await insert(
    db,
    "INSERT INTO society_memberships(society_id,user_id,status,joined_at) VALUES(?,?,'ACTIVE','2026-09-01')",
    [a.society, resident.user],
  );
  const role = await insert(
    db,
    "INSERT INTO roles(society_id,code,name) VALUES(?,'RESIDENT','Resident')",
    [a.society],
  );
  await db.execute('INSERT INTO membership_roles(society_id,membership_id,role_id) VALUES(?,?,?)', [
    a.society,
    membership,
    role,
  ]);
  // An accidental resident grant must still be capped by the server role policy.
  await db.execute(
    "INSERT INTO role_permissions(society_id,role_id,permission_id) SELECT ?,?,id FROM permissions WHERE code IN ('society.dashboard.read','society.notices.manage','society.complaints.manage')",
    [a.society, role],
  );
  await db.execute(
    "INSERT INTO flat_occupancies(society_id,flat_id,person_id,occupancy_type,starts_on) VALUES(?,?,?,'TENANT','2026-09-01')",
    [a.society, a.flat, resident.person],
  );
  await grantTestRuntime();
  const database = await openRuntime(process.env);
  const queue = new ResetQueue(() => undefined);
  const auth = await AuthService.create(
    new AuthRepository(database),
    {
      origin: 'http://127.0.0.1:4200',
      secret: 'c'.repeat(64),
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
  const logs: string[] = [];
  const server = createApp(
    auth,
    (code) => logs.push(code),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    residentPortalModule(new ResidentAccess(database, clock)),
    communityModule(new CommunityAccess(database, clock)),
  ).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = 'http://127.0.0.1:' + address.port;
  function client() {
    const value = new AuthClient(baseUrl, auth.config.origin);
    const request = value.request.bind(value);
    value.request = async (...args: Parameters<AuthClient['request']>) => {
      await delay(550);
      return request(...args);
    };
    return value;
  }
  const committee = client(),
    member = client(),
    anonymous = client();
  const base = '/society/community';
  let noticeId = '',
    complaintId = '';
  try {
    await committee.login('community-admin@example.invalid', password);
    await member.login('community-resident@example.invalid', password);
    for (const value of [committee, member])
      assert.equal(
        (await value.request('/auth/society-context', { societyId: String(a.society) })).status,
        204,
      );
    await suite.test(
      'notice drafts, editing, publication and archives are tenant scoped and audited',
      async () => {
        const body = {
          title: 'Water <img src=x onerror=alert(1)>',
          body: 'Plain <script>alert(1)</script>\nUpdate',
        };
        const draft = await committee.request(base + '/notices', body);
        assert.equal(draft.status, 201);
        noticeId = String(draft.data['id']);
        assert.equal((await member.request('/society/resident/notices/' + noticeId)).status, 404);
        assert.equal(
          (
            await committee.request(base + '/notices/' + noticeId + '/edit', {
              ...body,
              title: 'Updated title',
              revision: 1,
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await committee.request(base + '/notices/' + noticeId + '/action', {
              revision: 1,
              action: 'PUBLISH',
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await committee.request(base + '/notices/' + noticeId + '/action', {
              revision: 2,
              action: 'PUBLISH',
            })
          ).status,
          200,
        );
        const published = await member.request('/society/resident/notices/' + noticeId);
        assert.equal(published.status, 200);
        assert.equal(published.data['body'], body.body);
        assert.equal(published.data['publishedAt'], '2026-10-03T06:30:00.000Z');
        assert.equal(
          (
            await committee.request(base + '/notices/' + noticeId + '/action', {
              revision: 3,
              action: 'PUBLISH',
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await committee.request(base + '/notices/' + noticeId + '/action', {
              revision: 3,
              action: 'ARCHIVE',
            })
          ).status,
          200,
        );
        assert.equal((await member.request('/society/resident/notices/' + noticeId)).status, 404);
        assert.equal(
          (
            await committee.request(base + '/notices/' + noticeId + '/edit', {
              ...body,
              revision: 4,
            })
          ).status,
          409,
        );
      },
    );
    await suite.test(
      'notice search parameterizes SQL syntax and rejects assignment of protected fields',
      async () => {
        const result = await committee.request(
          '/society/community/notices?search=' + encodeURIComponent("' OR 1=1 --"),
        );
        assert.equal(result.status, 200);
        assert.equal(result.data['total'], 0);
        assert.deepEqual(result.data['items'], []);
        for (const field of [
          'society_id',
          'role',
          'actor_user_id',
          'created_by_membership_id',
          'safe_metadata',
        ]) {
          const result = await committee.request('/society/community/notices', {
            title: 'Protected probe',
            body: 'Synthetic text',
            [field]: '999999',
          });
          assert.equal(result.status, 400);
        }
      },
    );
    await suite.test(
      'resident creates categorized private complaint with initial history',
      async () => {
        const submitted = await member.request('/society/resident/complaints', {
          flatId: String(a.flat),
          category: 'PLUMBING',
          title: 'Pipe leak',
          description: 'Literal <img src=x onerror=alert(1)>',
        });
        assert.equal(submitted.status, 201);
        complaintId = String(submitted.data['id']);
        const result = await member.request('/society/resident/complaints/' + complaintId);
        assert.equal(result.data['status'], 'NEW');
        assert.equal(result.data['category'], 'PLUMBING');
        assert.ok(!result.raw.includes('assigneeMembershipId'));
        assert.equal(
          (await member.request('/society/resident/complaints/' + complaintId + '/history')).data[
            'total'
          ],
          1,
        );
        assert.equal(
          (await committee.request('/society/resident/complaints/' + complaintId)).status,
          404,
        );
      },
    );
    await suite.test(
      'status sequence, assignment validation and revision conflicts preserve history',
      async () => {
        const action = (revision: number, status: string, extra: object = {}) =>
          committee.request(base + '/complaints/' + complaintId + '/status', {
            revision,
            status,
            note: 'Visible update',
            ...extra,
          });
        assert.equal((await action(1, 'RESOLVED')).status, 409);
        assert.equal(
          (await action(1, 'ASSIGNED', { assigneeMembershipId: String(membership) })).status,
          400,
        );
        assert.equal(
          (await action(1, 'ASSIGNED', { assigneeMembershipId: String(b.membership) })).status,
          400,
        );
        assert.equal((await action(1, 'ASSIGNED')).status, 400);
        assert.equal(
          (await action(1, 'ASSIGNED', { assigneeMembershipId: String(a.membership) })).status,
          200,
        );
        const session = await auth.readSession(committee.cookie.split('=')[1] ?? '');
        assert.ok(session);
        const service = communityModule(new CommunityAccess(database, clock)).complaints;
        const races = await Promise.allSettled([
          service.change(
            session,
            complaintId,
            { revision: 2, status: 'IN_PROGRESS', note: 'Work started' },
            auth.audit('test', 'race-a'),
          ),
          service.change(
            session,
            complaintId,
            { revision: 2, status: 'IN_PROGRESS', note: 'Work started' },
            auth.audit('test', 'race-b'),
          ),
        ]);
        assert.equal(races.filter((value) => value.status === 'fulfilled').length, 1);
        assert.equal(races.filter((value) => value.status === 'rejected').length, 1);
        assert.equal((await action(3, 'RESOLVED')).status, 200);
        assert.equal((await action(4, 'CLOSED')).status, 200);
        assert.equal((await action(5, 'IN_PROGRESS')).status, 409);
        const result = await member.request('/society/resident/complaints/' + complaintId);
        assert.equal(result.data['status'], 'CLOSED');
        assert.equal(result.data['resolvedAt'], '2026-10-03T06:30:00.000Z');
        assert.equal(result.data['category'], 'PLUMBING');
        const history = await member.request(
          '/society/resident/complaints/' + complaintId + '/history?pageSize=2',
        );
        assert.equal(history.data['total'], 5);
        assert.ok(Array.isArray(history.data['items']));
        assert.equal(history.data['items'].length, 2);
        assert.equal(
          (await committee.request(base + '/complaints?status=CLOSED&category=PLUMBING&pageSize=1'))
            .data['total'],
          1,
        );
      },
    );
    await suite.test(
      'roles, CSRF, protected fields and unauthenticated requests fail safely',
      async () => {
        for (const path of ['/notices', '/complaints', '/complaints/assignees']) {
          assert.equal((await member.request(base + path)).status, 403);
          assert.equal((await anonymous.request(base + path)).status, 401);
        }
        assert.equal(
          (
            await member.request(base + '/complaints/' + complaintId + '/status', {
              revision: 5,
              status: 'CLOSED',
              note: 'Own approval',
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await committee.request(base + '/notices', {
              title: 'Test',
              body: 'Test',
              societyId: String(b.society),
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await committee.request(
              base + '/notices',
              { title: 'Test', body: 'Test' },
              { 'X-CSRF-Token': 'wrong' },
            )
          ).status,
          403,
        );
        assert.equal((await committee.request(base + '/complaints?sort=SQL')).status, 400);
        assert.equal((await committee.request(base + '/complaints?pageSize=51')).status, 400);
      },
    );
    await suite.test(
      'committee member permissions cannot reach another society notice or complaint',
      async () => {
        assert.equal(
          (await committee.request('/auth/society-context', { societyId: String(b.society) }))
            .status,
          204,
        );
        for (const path of [
          '/notices/' + noticeId,
          '/complaints/' + complaintId,
          '/complaints/' + complaintId + '/history',
        ])
          assert.equal((await committee.request(base + path)).status, 404);
        assert.equal(
          (
            await committee.request(base + '/notices', {
              title: 'Society B',
              body: 'Committee member publication',
            })
          ).status,
          201,
        );
        assert.equal(
          (await committee.request('/auth/society-context', { societyId: String(a.society) }))
            .status,
          204,
        );
      },
    );
    await suite.test(
      'legacy OPEN complaints map to NEW without overwriting stored records',
      async () => {
        const legacy = await insert(
          db,
          "INSERT INTO complaints(society_id,submitted_by_membership_id,flat_id,title,description) VALUES(?,?,?,'Legacy','Existing data')",
          [a.society, membership, a.flat],
        );
        const result = await committee.request(base + '/complaints/' + legacy);
        assert.equal(result.data['status'], 'NEW');
        assert.equal(result.data['category'], 'OTHER');
        assert.equal(
          (
            await committee.request(base + '/complaints/' + legacy + '/status', {
              revision: 1,
              status: 'ASSIGNED',
              assigneeMembershipId: String(a.membership),
              note: 'Assigned from legacy',
            })
          ).status,
          200,
        );
        const [rows] = await db.execute<RowDataPacket[]>(
          'SELECT status FROM complaints WHERE id=?',
          [legacy],
        );
        assert.equal(rows[0]?.['status'], 'OPEN');
      },
    );
    await suite.test(
      'database tenant foreign keys and immutable complaint history enforce boundaries',
      async () => {
        await assert.rejects(
          db.execute(
            'UPDATE complaint_workflows SET assigned_to_membership_id=? WHERE complaint_id=?',
            [b.membership, complaintId],
          ),
          (error) =>
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'ER_NO_REFERENCED_ROW_2',
        );
        await assert.rejects(
          db.execute('DELETE FROM complaint_status_history WHERE complaint_id=?', [complaintId]),
        );
        await assert.rejects(
          db.execute("UPDATE complaint_status_history SET note='rewrite' WHERE complaint_id=?", [
            complaintId,
          ]),
        );
        await assert.rejects(
          database.rows('DELETE FROM complaint_workflows WHERE complaint_id=?', [complaintId]),
        );
        const [audit] = await db.execute<RowDataPacket[]>(
          "SELECT COUNT(*) AS total FROM audit_logs WHERE society_id=? AND action IN ('notice.created','notice.edited','notice.publish','notice.archive','complaint.status_changed')",
          [a.society],
        );
        assert.ok(Number(audit[0]?.['total']) >= 8);
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
