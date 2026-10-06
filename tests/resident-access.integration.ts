import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { openRuntime } from '../src/database/runtime.js';
import { AuthRepository } from '../src/auth/repository.js';
import { AuthService } from '../src/auth/service.js';
import { ResetQueue } from '../src/auth/reset-queue.js';
import { hashPassword, tokenHash, newToken } from '../src/auth/crypto.js';
import { PropertyService } from '../src/property/service.js';
import { PropertyAccess } from '../src/property/access.js';
import { OccupancyService } from '../src/property/occupancies.js';
import { ImportService } from '../src/property/imports/service.js';
import { ResidentAccounts } from '../src/resident-access/accounts.js';
import { ResidentIdentity } from '../src/resident-access/identity.js';
import { ResidentInvitations } from '../src/resident-access/invitations.js';
import { ResidentRequests } from '../src/resident-access/requests.js';
import { createApp } from '../src/http/app.js';
import { AuthClient } from './auth-client.js';
import { createFixture, insert } from './fixtures.js';
import { grantTestRuntime } from './runtime-provision.js';
export async function residentAccessIntegration(suite: TestContext, db: Connection): Promise<void> {
  const password = 'Synthetic Step 6 password';
  const encoded = await hashPassword(password);
  async function account(email: string) {
    const person = await insert(db, 'INSERT INTO persons() VALUES()');
    const user = await insert(
      db,
      "INSERT INTO users(person_id,email_normalized,password_hash,status,email_verified_at) VALUES(?,?,?,'ACTIVE',UTC_TIMESTAMP(6))",
      [person, email, encoded],
    );
    return { person, user, email };
  }
  const admin = await account('step6-admin@example.invalid'),
    other = await account('step6-other@example.invalid'),
    existing = await account('step6-existing@example.invalid'),
    applicant = await account('step6-applicant@example.invalid'),
    rejected = await account('step6-rejected@example.invalid'),
    platform = await account('step6-platform@example.invalid');
  const a = await createFixture(db, 'STEP6_A', admin.user, admin.person, 'COMMITTEE_ADMIN'),
    b = await createFixture(db, 'STEP6_B', other.user, other.person, 'COMMITTEE_ADMIN'),
    c = await createFixture(db, 'STEP6_C', existing.user, existing.person, 'ACCOUNTANT');
  for (const f of [a, b]) {
    const role = await insert(
      db,
      "INSERT INTO roles(society_id,code,name) VALUES(?,'RESIDENT','Resident')",
      [f.society],
    );
    await db.execute(
      "INSERT INTO role_permissions(society_id,role_id,permission_id) SELECT ?,?,id FROM permissions WHERE code='society.dashboard.read'",
      [f.society, role],
    );
    await db.execute(
      "INSERT INTO role_permissions(society_id,role_id,permission_id) SELECT ?,?,id FROM permissions WHERE code='society.members.manage'",
      [f.society, f.role],
    );
  }
  await db.execute(
    "INSERT INTO role_permissions(society_id,role_id,permission_id) SELECT ?,?,id FROM permissions WHERE code='society.dashboard.read'",
    [c.society, c.role],
  );
  await db.execute(
    "INSERT INTO platform_user_roles(user_id,role_code) VALUES(?,'PLATFORM_ADMIN')",
    [platform.user],
  );
  await db.execute("UPDATE societies SET status='ACTIVE' WHERE id IN(?,?,?)", [
    a.society,
    b.society,
    c.society,
  ]);
  async function person(email: string) {
    const id = await insert(db, 'INSERT INTO persons() VALUES()');
    await db.execute(
      'INSERT INTO society_persons(society_id,person_id,display_name,contact_email) VALUES(?,?,?,?)',
      [a.society, id, 'Synthetic invited person', email],
    );
    const occupancy = await insert(
      db,
      "INSERT INTO flat_occupancies(society_id,flat_id,person_id,occupancy_type,starts_on) VALUES(?,?,?,'TENANT','2020-01-01')",
      [a.society, a.flat, id],
    );
    return { id, occupancy };
  }
  const target = await person(existing.email),
    rotation = await person('step6-rotation@example.invalid'),
    fresh = await person('step6-new-invite@example.invalid');
  await grantTestRuntime();
  const database = await openRuntime(process.env);
  const logs: string[] = [];
  const queue = new ResetQueue((code) => logs.push(code));
  const mail: { kind: string; email: string; token: string }[] = [];
  const capture = (kind: string) => (email: string, link: string) => {
    mail.push({ kind, email, token: new URL(link).hash.replace('#token=', '') });
    return Promise.resolve();
  };
  const auth = await AuthService.create(
    new AuthRepository(database),
    {
      origin: 'http://127.0.0.1:4200',
      secret: '6'.repeat(64),
      secure: false,
      cookieName: 'livora_session',
      idleMs: 1800000,
      absoluteMs: 43200000,
      resetMs: 1800000,
    },
    { send: () => Promise.resolve() },
    queue,
  );
  let residentNow = Date.now();
  const property = new PropertyService(new PropertyAccess(database, () => residentNow));
  const occupancy = new OccupancyService(property);
  const imports = new ImportService(property, occupancy);
  const accounts = new ResidentAccounts(
    auth,
    auth.config.origin,
    {
      verification: capture('verify'),
      existingAccount: capture('existing'),
      invitation: capture('invite'),
    },
    queue,
  );
  const identity = new ResidentIdentity(property),
    invitations = new ResidentInvitations(identity, accounts),
    requests = new ResidentRequests(identity, occupancy);
  const server = createApp(
    auth,
    (code) => logs.push(code),
    undefined,
    undefined,
    { service: property, occupancy, imports },
    { accounts, invitations, requests },
  ).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = 'http://127.0.0.1:' + address.port;
  let nextRequest = Date.now();
  const client = () => {
    const value = new AuthClient(base, auth.config.origin),
      request = value.request.bind(value);
    value.request = async (path: string, body?: unknown, extra: Record<string, string> = {}) => {
      const slot = Math.max(Date.now(), nextRequest);
      nextRequest = slot + 650;
      await delay(Math.max(0, slot - Date.now()));
      return request(path, body, extra);
    };
    return value;
  };
  const committee = client(),
    foreign = client(),
    holder = client(),
    anonymous = client(),
    joiner = client(),
    declined = client(),
    root = client();
  const latest = (address: string, kind = 'invite') => {
    const m = mail.findLast((m) => m.email === address && m.kind === kind);
    assert.ok(m);
    return m.token;
  };
  const claim = {
    societyCode: 'STEP6_A',
    buildingCode: 'A',
    flatNumber: '101',
    occupancyType: 'TENANT',
    displayName: 'New tenant claim',
    contactPhone: null,
    note: 'Synthetic identity evidence to verify offline',
  };
  const approval = {
    confirmed: true,
    note: 'Committee checked identity and tenancy against its records',
    personId: null,
    flatId: String(a.flat),
    existingOccupancyId: null,
    occupancyType: 'TENANT',
    startsOn: '2020-01-01',
    endsOn: null,
  };
  let firstToken = '',
    rotateToken = '',
    rotateId = '',
    requestId = '',
    rejectId = '';
  try {
    await committee.login(admin.email, password);
    await committee.request('/auth/society-context', { societyId: String(a.society) });
    await foreign.login(other.email, password);
    await foreign.request('/auth/society-context', { societyId: String(b.society) });
    await holder.login(existing.email, password);
    await anonymous.bootstrap();
    await joiner.login(applicant.email, password);
    await declined.login(rejected.email, password);
    await root.login(platform.email, password);
    await suite.test(
      'committee invitation binds existing tenant person, email and occupancy without account enumeration',
      async () => {
        const r = await committee.request('/society/resident-invitations', {
          personId: String(target.id),
          flatId: String(a.flat),
          confirmed: true,
        });
        assert.equal(r.status, 201, r.raw);
        await queue.idle();
        firstToken = latest(existing.email);
        const preview = await anonymous.request('/resident-access/invitations/inspect', {
          token: firstToken,
        });
        assert.equal(preview.status, 200);
        assert.equal(preview.data['action'], 'RESIDENT_JOIN');
        assert.equal('requiresLogin' in preview.data, false);
        const [rows] = await db.execute<RowDataPacket[]>(
          'SELECT token_hash FROM invitations WHERE id=?',
          [String(r.data['id'])],
        );
        assert.ok(Buffer.isBuffer(rows[0]?.['token_hash']));
        assert.deepEqual(rows[0]?.['token_hash'], tokenHash(firstToken));
        assert.equal(
          (await holder.request('/resident-access/account/verify', { token: firstToken })).status,
          400,
        );
      },
    );
    await suite.test(
      'wrong account and password replacement cannot consume a resident invitation',
      async () => {
        assert.equal(
          (await foreign.request('/resident-access/invitations/accept', { token: firstToken }))
            .status,
          400,
        );
        assert.equal(
          (
            await holder.request('/resident-access/invitations/accept', {
              token: firstToken,
              password,
            })
          ).status,
          400,
        );
      },
    );
    await suite.test(
      'concurrent acceptance has one winner, reuses global user and preserves identity and occupancy',
      async () => {
        const result = await Promise.all([
          holder.request('/resident-access/invitations/accept', { token: firstToken }),
          holder.request('/resident-access/invitations/accept', { token: firstToken }),
        ]);
        assert.deepEqual(result.map((r) => r.status).sort(), [204, 400]);
        assert.equal(
          (await holder.request('/resident-access/invitations/accept', { token: firstToken }))
            .status,
          400,
        );
        const [users] = await db.execute<RowDataPacket[]>(
          'SELECT id,person_id,password_hash FROM users WHERE email_normalized=?',
          [existing.email],
        );
        assert.equal(users.length, 1);
        assert.equal(String(users[0]?.['id']), String(existing.user));
        assert.equal(String(users[0]?.['person_id']), String(existing.person));
        assert.equal(users[0]?.['password_hash'], encoded);
        const [link] = await db.execute<RowDataPacket[]>(
          'SELECT l.person_id FROM membership_person_links l JOIN society_memberships m ON m.society_id=l.society_id AND m.id=l.membership_id WHERE l.society_id=? AND m.user_id=?',
          [a.society, existing.user],
        );
        assert.equal(String(link[0]?.['person_id']), String(target.id));
        const [history] = await db.execute<RowDataPacket[]>(
          'SELECT person_id FROM flat_occupancies WHERE id=?',
          [target.occupancy],
        );
        assert.equal(String(history[0]?.['person_id']), String(target.id));
        const memberships = (await holder.request('/auth/session')).data['memberships'];
        assert.ok(Array.isArray(memberships));
        assert.equal(memberships.length, 2);
        assert.equal(
          (await holder.request('/auth/society-context', { societyId: String(a.society) })).status,
          204,
        );
        assert.equal((await holder.request('/society/access')).status, 200);
        assert.equal((await holder.request('/society/registration-requests')).status, 403);
      },
    );
    await suite.test(
      'archiving linked person revokes that society access while preserving the other society role',
      async () => {
        await db.execute(
          'UPDATE society_persons SET archived_at=UTC_TIMESTAMP(6) WHERE society_id=? AND person_id=?',
          [a.society, target.id],
        );
        assert.equal((await holder.request('/society/access')).status, 403);
        const history = await committee.request('/society/resident-invitations?status=all');
        assert.equal(history.status, 200);
        assert.equal(history.data['total'], 1);
        const records = history.data['items'];
        assert.ok(Array.isArray(records));
        assert.equal(records.length, 1);
        assert.ok(
          records.some(
            (record: unknown) =>
              typeof record === 'object' &&
              record !== null &&
              'personId' in record &&
              record.personId === String(target.id) &&
              'status' in record &&
              record.status === 'ACCEPTED',
          ),
        );
        assert.equal(
          (await holder.request('/auth/society-context', { societyId: String(c.society) })).status,
          204,
        );
        assert.equal((await holder.request('/society/access')).status, 200);
        await db.execute(
          'UPDATE society_persons SET archived_at=NULL WHERE society_id=? AND person_id=?',
          [a.society, target.id],
        );
      },
    );
    await suite.test(
      'expiry, resend and revoke invalidate old tokens and preserve status history',
      async () => {
        const r = await committee.request('/society/resident-invitations', {
          personId: String(rotation.id),
          flatId: String(a.flat),
          confirmed: true,
        });
        assert.equal(r.status, 201, r.raw);
        rotateId = String(r.data['id']);
        await queue.idle();
        rotateToken = latest('step6-rotation@example.invalid');
        const previous = residentNow;
        residentNow += 73 * 3600000;
        await invitations.expire();
        assert.equal(
          (await anonymous.request('/resident-access/invitations/inspect', { token: rotateToken }))
            .status,
          400,
        );
        residentNow = previous;
        const resent = await committee.request(
          '/society/resident-invitations/' + rotateId + '/resend',
          { confirmed: true, note: 'Resend requested' },
        );
        assert.equal(resent.status, 201, resent.raw);
        await queue.idle();
        const newLink = latest('step6-rotation@example.invalid');
        assert.notEqual(newLink, rotateToken);
        assert.equal(
          (
            await anonymous.request('/resident-access/invitations/accept', {
              token: rotateToken,
              password,
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await committee.request(
              '/society/resident-invitations/' + String(resent.data['id']) + '/revoke',
              { confirmed: true, note: 'Committee revoked' },
            )
          ).status,
          204,
        );
        assert.equal(
          (
            await anonymous.request('/resident-access/invitations/accept', {
              token: newLink,
              password,
            })
          ).status,
          400,
        );
      },
    );
    await suite.test(
      'new invite creates one account on the intended existing person with Resident privileges only',
      async () => {
        const r = await committee.request('/society/resident-invitations', {
          personId: String(fresh.id),
          flatId: String(a.flat),
          confirmed: true,
        });
        assert.equal(r.status, 201, r.raw);
        await queue.idle();
        const token = latest('step6-new-invite@example.invalid');
        assert.equal(
          (await anonymous.request('/resident-access/invitations/accept', { token, password }))
            .status,
          204,
        );
        assert.equal(
          (await anonymous.request('/resident-access/invitations/accept', { token, password }))
            .status,
          400,
        );
        const freshClient = client();
        await freshClient.login('step6-new-invite@example.invalid', password);
        const memberships = (await freshClient.request('/auth/session')).data['memberships'];
        assert.ok(Array.isArray(memberships));
        const membership: unknown = memberships[0];
        assert.ok(typeof membership === 'object' && membership !== null && 'roles' in membership);
        assert.deepEqual(membership.roles, ['RESIDENT']);
      },
    );
    await suite.test(
      'creation/acceptance rate limits and cross-tenant invitation IDs are enforced by HTTP',
      async () => {
        assert.equal(
          (
            await committee.request('/society/resident-invitations', {
              personId: String(fresh.id),
              flatId: String(a.flat),
              confirmed: true,
            })
          ).status,
          429,
        );
        assert.equal(
          (await holder.request('/resident-access/invitations/accept', { token: firstToken }))
            .status,
          429,
        );
        assert.equal(
          (
            await foreign.request('/society/resident-invitations/' + rotateId + '/revoke', {
              confirmed: true,
              note: 'Foreign attempt',
            })
          ).status,
          404,
        );
        assert.equal(
          (
            await foreign.request('/society/resident-invitations', {
              personId: String(target.id),
              flatId: String(a.flat),
              confirmed: true,
            })
          ).status,
          404,
        );
        assert.equal((await root.request('/society/resident-invitations')).status, 403);
      },
    );
    await suite.test(
      'signup responses are enumeration-safe and email proof creates no society access',
      async () => {
        const input = {
          email: 'step6-signup@example.invalid',
          password,
          displayName: 'Synthetic signup',
        };
        const old = await anonymous.request('/resident-access/account/start', {
          ...input,
          email: existing.email,
        });
        const freshResponse = await anonymous.request('/resident-access/account/start', input);
        assert.equal(old.status, 202);
        assert.equal(freshResponse.status, 202);
        assert.deepEqual(freshResponse.data, old.data);
        await queue.idle();
        assert.equal(latest(existing.email, 'existing'), '');
        const token = latest(input.email, 'verify');
        assert.equal(
          (await anonymous.request('/resident-access/invitations/inspect', { token })).status,
          400,
        );
        assert.equal(
          (await anonymous.request('/resident-access/account/verify', { token })).status,
          204,
        );
        assert.equal(
          (await anonymous.request('/resident-access/account/verify', { token })).status,
          400,
        );
        const freshClient = client();
        await freshClient.login(input.email, password);
        assert.deepEqual((await freshClient.request('/auth/session')).data['memberships'], []);
        assert.equal((await freshClient.request('/society/access')).status, 403);
      },
    );
    await suite.test(
      'self registration is pending with no membership, profile or occupancy; protected fields rejected',
      async () => {
        const r = await joiner.request('/resident-access/requests', claim);
        assert.equal(r.status, 201, r.raw);
        requestId = String(r.data['id']);
        assert.equal(r.data['status'], 'PENDING');
        assert.deepEqual((await joiner.request('/auth/session')).data['memberships'], []);
        assert.equal(
          (await joiner.request('/auth/society-context', { societyId: String(a.society) })).status,
          403,
        );
        assert.equal((await joiner.request('/society/flats/' + a.flat)).status, 403);
        const [members] = await db.execute<RowDataPacket[]>(
          'SELECT id FROM society_memberships WHERE society_id=? AND user_id=?',
          [a.society, applicant.user],
        );
        assert.equal(members.length, 0);
        const [profiles] = await db.execute<RowDataPacket[]>(
          'SELECT id FROM society_persons WHERE society_id=? AND person_id=?',
          [a.society, applicant.person],
        );
        assert.equal(profiles.length, 0);
        assert.equal(
          (
            await joiner.request('/resident-access/requests', {
              ...claim,
              userId: String(other.user),
              role: 'COMMITTEE_ADMIN',
            })
          ).status,
          400,
        );
        assert.equal((await joiner.request('/resident-access/requests', claim)).status, 409);
        assert.equal(
          (
            await foreign.request(
              '/society/registration-requests/' + requestId + '/approve',
              approval,
            )
          ).status,
          404,
        );
        assert.equal(
          (
            await holder.request(
              '/society/registration-requests/' + requestId + '/approve',
              approval,
            )
          ).status,
          403,
        );
        assert.equal(
          (await root.request('/society/registration-requests/' + requestId + '/approve', approval))
            .status,
          403,
        );
      },
    );
    await suite.test(
      'approval rejects wrong tenant/person/occupancy evidence and rolls back all changes',
      async () => {
        assert.equal(
          (
            await committee.request('/society/registration-requests/' + requestId + '/approve', {
              ...approval,
              personId: String(other.person),
            })
          ).status,
          404,
        );
        assert.equal(
          (
            await committee.request('/society/registration-requests/' + requestId + '/approve', {
              ...approval,
              flatId: String(b.flat),
            })
          ).status,
          404,
        );
        assert.equal(
          (
            await committee.request('/society/registration-requests/' + requestId + '/approve', {
              ...approval,
              personId: String(target.id),
              existingOccupancyId: String(target.occupancy),
              occupancyType: 'OWNER',
            })
          ).status,
          409,
        );
        const [members] = await db.execute<RowDataPacket[]>(
          'SELECT id FROM society_memberships WHERE user_id=?',
          [applicant.user],
        );
        assert.equal(members.length, 0);
      },
    );
    await suite.test(
      'concurrent approval has one winner, correct identity/occupancy, verifier and immutable audit',
      async () => {
        const responses = await Promise.all([
          committee.request('/society/registration-requests/' + requestId + '/approve', approval),
          committee.request('/society/registration-requests/' + requestId + '/approve', approval),
        ]);
        assert.deepEqual(responses.map((r) => r.status).sort(), [204, 409]);
        const [result] = await db.execute<RowDataPacket[]>(
          'SELECT r.status,r.reviewed_by_membership_id,d.resolved_person_id,m.user_id,o.person_id FROM registration_requests r JOIN registration_request_details d ON d.society_id=r.society_id AND d.request_id=r.id JOIN society_memberships m ON m.society_id=d.society_id AND m.id=d.approved_membership_id JOIN flat_occupancies o ON o.society_id=d.society_id AND o.id=d.approved_occupancy_id WHERE r.id=?',
          [requestId],
        );
        assert.equal(result[0]?.['status'], 'APPROVED');
        assert.equal(String(result[0]?.['user_id']), String(applicant.user));
        assert.equal(String(result[0]?.['resolved_person_id']), String(applicant.person));
        assert.equal(String(result[0]?.['person_id']), String(applicant.person));
        assert.equal(String(result[0]?.['reviewed_by_membership_id']), String(a.membership));
        const [audit] = await db.execute<RowDataPacket[]>(
          "SELECT id FROM audit_logs WHERE society_id=? AND entity_id=? AND action='resident.registration_approved'",
          [a.society, requestId],
        );
        assert.equal(audit.length, 1);
        assert.equal(
          (await joiner.request('/auth/society-context', { societyId: String(a.society) })).status,
          204,
        );
        assert.equal((await joiner.request('/society/access')).status, 200);
        await assert.rejects(
          db.execute(
            "UPDATE registration_requests SET status='PENDING',reviewed_at=NULL,reviewed_by_membership_id=NULL WHERE id=?",
            [requestId],
          ),
        );
      },
    );
    await suite.test(
      'rejection, owner-only cancellation and paginated status preserve no-access decisions',
      async () => {
        const r = await declined.request('/resident-access/requests', claim);
        assert.equal(r.status, 201, r.raw);
        rejectId = String(r.data['id']);
        assert.equal(
          (
            await joiner.request('/resident-access/requests/' + rejectId + '/cancel', {
              confirmed: true,
              note: 'Foreign cancellation',
            })
          ).status,
          404,
        );
        assert.equal(
          (
            await committee.request('/society/registration-requests/' + rejectId + '/reject', {
              confirmed: true,
              note: 'Identity could not be verified',
            })
          ).status,
          204,
        );
        assert.deepEqual((await declined.request('/auth/session')).data['memberships'], []);
        const retry = await declined.request('/resident-access/requests', claim);
        assert.equal(retry.status, 201, retry.raw);
        assert.equal(
          (
            await declined.request(
              '/resident-access/requests/' + String(retry.data['id']) + '/cancel',
              {
                confirmed: true,
                note: 'Applicant cancelled',
              },
            )
          ).status,
          204,
        );
        assert.equal(
          (
            await committee.request(
              '/society/registration-requests/' + String(retry.data['id']) + '/approve',
              approval,
            )
          ).status,
          409,
        );
        const list = await declined.request('/resident-access/requests?status=all&page=1');
        assert.equal(list.status, 200, list.raw);
        assert.equal(list.data['pageSize'], 20);
        assert.ok(Array.isArray(list.data['items']));
        assert.equal(list.data['items'].length, 2);
        const noMatches = await declined.request(
          '/resident-access/requests?status=all&search=definitely-not-a-society&page=1',
        );
        assert.equal(noMatches.status, 200, noMatches.raw);
        assert.equal(noMatches.data['total'], 0);
        assert.deepEqual(noMatches.data['items'], []);
        assert.equal(
          (await committee.request('/society/registration-requests?societyId=' + b.society)).status,
          400,
        );
        assert.equal(
          (await committee.request('/society/resident-invitations?status=all&page=1')).status,
          200,
        );
      },
    );
    await suite.test(
      'existing global user joins a third society through approval without another account',
      async () => {
        const result = await holder.request('/resident-access/requests', {
          ...claim,
          societyCode: 'STEP6_B',
        });
        assert.equal(result.status, 201, result.raw);
        assert.equal(
          (await holder.request('/auth/society-context', { societyId: String(b.society) })).status,
          403,
        );
        assert.equal(
          (
            await foreign.request(
              '/society/registration-requests/' + String(result.data['id']) + '/approve',
              { ...approval, flatId: String(b.flat) },
            )
          ).status,
          204,
        );
        const [users] = await db.execute<RowDataPacket[]>(
          'SELECT id,person_id FROM users WHERE email_normalized=?',
          [existing.email],
        );
        assert.equal(users.length, 1);
        assert.equal(String(users[0]?.['id']), String(existing.user));
        assert.equal(String(users[0]?.['person_id']), String(existing.person));
        const members = (await holder.request('/auth/session')).data['memberships'];
        assert.ok(Array.isArray(members));
        assert.equal(members.length, 3);
      },
    );
    await suite.test(
      'approval explicitly links a pre-existing person and occupancy, preserving the original record',
      async () => {
        const login = await account('step6-existing-occupancy@example.invalid');
        const profile = await person(login.email);
        const owner = client();
        await owner.login(login.email, password);
        const result = await owner.request('/resident-access/requests', claim);
        assert.equal(result.status, 201, result.raw);
        assert.equal(
          (
            await committee.request(
              '/society/registration-requests/' + String(result.data['id']) + '/approve',
              {
                ...approval,
                personId: String(profile.id),
                existingOccupancyId: String(profile.occupancy),
              },
            )
          ).status,
          204,
        );
        const [proof] = await db.execute<RowDataPacket[]>(
          'SELECT d.resolved_person_id,d.approved_occupancy_id,o.person_id FROM registration_request_details d JOIN flat_occupancies o ON o.society_id=d.society_id AND o.id=d.approved_occupancy_id WHERE d.request_id=?',
          [String(result.data['id'])],
        );
        assert.equal(String(proof[0]?.['resolved_person_id']), String(profile.id));
        assert.equal(String(proof[0]?.['approved_occupancy_id']), String(profile.occupancy));
        assert.equal(String(proof[0]?.['person_id']), String(profile.id));
      },
    );
    await suite.test(
      'expired email verification is rejected and sensitive challenge fields are scrubbed',
      async () => {
        const token = newToken();
        await db.execute(
          "INSERT INTO resident_account_verifications(token_hash,email_normalized,display_name,password_hash,expires_at,created_at) VALUES(?,'step6-expired@example.invalid','Expired fixture',?,DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 1 HOUR),DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 2 HOUR))",
          [tokenHash(token), encoded],
        );
        assert.equal(
          (await anonymous.request('/resident-access/account/verify', { token })).status,
          400,
        );
        await accounts.expire();
        const [proof] = await db.execute<RowDataPacket[]>(
          'SELECT email_normalized,password_hash FROM resident_account_verifications WHERE token_hash=?',
          [tokenHash(token)],
        );
        assert.equal(proof[0]?.['email_normalized'], null);
        assert.equal(proof[0]?.['password_hash'], null);
        const [users] = await db.execute<RowDataPacket[]>(
          'SELECT id FROM users WHERE email_normalized=?',
          ['step6-expired@example.invalid'],
        );
        assert.equal(users.length, 0);
      },
    );
    await suite.test(
      'CSRF, anonymous approval and random tokens are rejected without private diagnostics',
      async () => {
        assert.equal(
          (
            await anonymous.request(
              '/society/registration-requests/' + rejectId + '/approve',
              approval,
            )
          ).status,
          401,
        );
        assert.equal(
          (
            await committee.request(
              '/society/registration-requests/' + rejectId + '/reject',
              { confirmed: true, note: 'Retry' },
              { 'X-CSRF-Token': 'bad' },
            )
          ).status,
          403,
        );
        const bad = await anonymous.request('/resident-access/invitations/inspect', {
          token: newToken(),
        });
        assert.equal(bad.status, 400);
        assert.equal(/stack|SELECT |token_hash|password_hash/.test(bad.raw), false);
        assert.deepEqual(logs, []);
      },
    );
  } finally {
    await queue.idle();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    await database.pool.end();
  }
}
