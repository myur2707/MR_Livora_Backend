import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { TestContext } from 'node:test';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { openRuntime } from '../src/database/runtime.js';
import { AuthRepository } from '../src/auth/repository.js';
import { AuthService } from '../src/auth/service.js';
import { ResetQueue } from '../src/auth/reset-queue.js';
import { hashPassword, tokenHash } from '../src/auth/crypto.js';
import { OnboardingRepository } from '../src/onboarding/repository.js';
import { OnboardingService } from '../src/onboarding/service.js';
import { InvitationService } from '../src/onboarding/invitations.js';
import { createApp } from '../src/http/app.js';
import { AuthClient } from './auth-client.js';
import { insert } from './fixtures.js';
import { grantTestRuntime } from './runtime-provision.js';
export async function onboardingIntegration(suite: TestContext, db: Connection): Promise<void> {
  const password = 'Synthetic onboarding password';
  const encoded = await hashPassword(password);
  async function account(email: string, platform = false) {
    const person = await insert(db, 'INSERT INTO persons() VALUES()');
    const user = await insert(
      db,
      "INSERT INTO users(person_id,email_normalized,password_hash,status) VALUES(?,?,?,'ACTIVE')",
      [person, email, encoded],
    );
    if (platform)
      await db.execute(
        "INSERT INTO platform_user_roles(user_id,role_code) VALUES(?,'PLATFORM_ADMIN')",
        [user],
      );
    return user;
  }
  const platformUser = await account('step4-platform@example.invalid', true);
  const existingUser = await account('step4-existing@example.invalid');
  await account('step4-outsider@example.invalid');
  await grantTestRuntime();
  const database = await openRuntime(process.env);
  const logs: string[] = [];
  const log = (code: string) => {
    logs.push(code);
  };
  const queue = new ResetQueue(log);
  let clockOffset = 0;
  const auth = await AuthService.create(
    new AuthRepository(database),
    {
      origin: 'http://127.0.0.1:4200',
      secret: 'd'.repeat(64),
      secure: false,
      cookieName: 'livora_session',
      idleMs: 1800000,
      absoluteMs: 43200000,
      resetMs: 1800000,
    },
    { send: () => Promise.resolve() },
    queue,
    () => Date.now() + clockOffset,
  );
  const service = new OnboardingService(new OnboardingRepository(database));
  const delivered: { email: string; link: string }[] = [];
  const invitations = new InvitationService(
    service,
    auth.config.origin,
    {
      send(email, link) {
        delivered.push({ email, link });
        return Promise.resolve();
      },
    },
    queue,
  );
  const server = createApp(auth, log, undefined, { service, invitations }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = 'http://127.0.0.1:' + address.port;
  const platform = new AuthClient(base, auth.config.origin);
  const outsider = new AuthClient(base, auth.config.origin);
  const committee = new AuthClient(base, auth.config.origin);
  const anonymous = new AuthClient(base, auth.config.origin);
  const detail = async (client: AuthClient, id: string, scope = 'platform') => {
    const response = await client.request('/' + scope + '/societies/' + id);
    assert.equal(response.status, 200, response.raw);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return response.data;
  };
  const revision = async (client: AuthClient, id: string, scope = 'platform') => {
    const value = (await detail(client, id, scope))['revision'];
    assert.equal(typeof value, 'string');
    return String(value);
  };
  const create = async (code: string) => {
    const response = await platform.request('/platform/societies', {
      code,
      name: code + ' society',
      timezone: 'Asia/Kolkata',
    });
    assert.equal(response.status, 201, response.raw);
    assert.equal(typeof response.data['id'], 'string');
    return String(response.data['id']);
  };
  const transition = async (id: string, status: string) => {
    const current = await detail(platform, id);
    return platform.request('/platform/societies/' + id + '/status', {
      revision: current['revision'],
      fromStatus: current['status'],
      status,
    });
  };
  const token = () => {
    const link = delivered.at(-1)?.link;
    assert.ok(link);
    return new URL(link).hash.slice(7);
  };
  let society = '';
  let currentToken = '';
  let flat = '';
  try {
    await platform.login('step4-platform@example.invalid', password);
    await outsider.login('step4-outsider@example.invalid', password);
    await anonymous.bootstrap();
    await suite.test(
      'platform endpoints deny anonymous, resident/committee scope, forged roles and unsupported queries',
      async () => {
        assert.equal((await anonymous.request('/platform/dashboard')).status, 401);
        assert.equal((await outsider.request('/platform/dashboard')).status, 403);
        assert.equal(
          (
            await outsider.request('/platform/societies', {
              code: 'EVIL',
              name: 'Fake',
              timezone: 'UTC',
            })
          ).status,
          403,
        );
        assert.equal((await platform.request('/platform/societies?pageSize=100000')).status, 400);
        assert.equal(
          (await platform.request('/platform/societies?sort=password_hash')).status,
          400,
        );
        assert.equal(
          (
            await platform.request('/platform/societies', {
              code: 'FAKE',
              name: 'Fake',
              timezone: 'UTC',
              status: 'ACTIVE',
              user_id: '1',
            })
          ).status,
          400,
        );
      },
    );
    await suite.test(
      'create, pagination, metadata dashboard and CSRF-protected lifecycle enforce legal transitions',
      async () => {
        society = await create('STEP4_A');
        assert.equal(
          (
            await platform.request('/platform/societies', {
              code: 'STEP4_A',
              name: 'Duplicate',
              timezone: 'UTC',
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await platform.request('/platform/societies/' + society + '/status', {
              revision: '1',
              fromStatus: 'DRAFT',
              status: 'ACTIVE',
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await platform.request(
              '/platform/societies/' + society + '/status',
              { revision: '1', status: 'SETUP_IN_PROGRESS' },
              { 'X-CSRF-Token': 'forged' },
            )
          ).status,
          403,
        );
        assert.equal((await transition(society, 'SETUP_IN_PROGRESS')).status, 204);
        assert.equal((await transition(society, 'PENDING_VERIFICATION')).status, 409);
        const directory = await platform.request(
          '/platform/societies?page=1&pageSize=1&status=SETUP_IN_PROGRESS',
        );
        assert.equal(directory.status, 200);
        assert.ok(Array.isArray(directory.data['items']));
        assert.equal(directory.data['items'].length, 1);
        const [legacyRows] = await db.execute<RowDataPacket[]>(
          'SELECT id FROM societies WHERE NOT EXISTS(SELECT 1 FROM society_onboarding WHERE society_id=societies.id) LIMIT 1',
        );
        const legacyId: unknown = legacyRows[0]?.['id'];
        assert.equal(typeof legacyId, 'string');
        const legacy = await detail(platform, String(legacyId));
        assert.equal(legacy['revision'], null);
        assert.deepEqual(legacy['events'], []);
        const dashboard = await platform.request('/platform/dashboard');
        assert.equal(dashboard.status, 200);
        assert.deepEqual(Object.keys(dashboard.data), [
          'statuses',
          'totalSocieties',
          'pendingVerification',
          'updatedAt',
        ]);
      },
    );
    await suite.test(
      'multi-wing batches are atomic, revision locked, tenant authorized and audited',
      async () => {
        // Independent scenarios use separate API-rate windows without changing production limits.
        clockOffset += 60_000;
        const id = await create('STEP4_BATCH');
        const path = '/platform/societies/' + id + '/buildings/batch';
        const wing = (code: string) => ({
          code,
          name: 'Wing ' + code,
          flats: [
            { number: '101', areaSqFt: null },
            { number: '102', areaSqFt: null },
          ],
        });
        let body = {
          revision: await revision(platform, id),
          buildings: ['A', 'B', 'C', 'D'].map(wing),
        };
        assert.equal((await platform.request(path, body)).status, 409, 'Draft is not editable');
        assert.equal((await transition(id, 'SETUP_IN_PROGRESS')).status, 204);
        body = { ...body, revision: await revision(platform, id) };
        assert.equal((await anonymous.request(path, body)).status, 401);
        assert.equal((await outsider.request(path, body)).status, 403);
        assert.equal(
          (await outsider.request('/onboarding/societies/' + id + '/buildings/batch', body)).status,
          404,
        );
        assert.equal(
          (await platform.request(path, body, { 'X-CSRF-Token': 'forged' })).status,
          403,
        );
        assert.equal((await platform.request(path, { ...body, society_id: society })).status, 400);
        const results = await Promise.all([
          platform.request(path, body),
          platform.request(path, body),
        ]);
        assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
        const current = await detail(platform, id);
        assert.equal(Number(current['revision']), Number(body.revision) + 1);
        const [counts] = await db.execute<RowDataPacket[]>(
          'SELECT COUNT(*) AS total FROM flats WHERE society_id=?',
          [id],
        );
        assert.equal(Number(counts[0]?.['total']), 8);
        const before = await revision(platform, id);
        assert.equal(
          (await platform.request(path, { revision: before, buildings: [wing('E'), wing('A')] }))
            .status,
          409,
        );
        assert.equal(
          await revision(platform, id),
          before,
          'Failed batch must not advance revision',
        );
        const [rolledBack] = await db.execute<RowDataPacket[]>(
          'SELECT COUNT(*) AS total FROM buildings WHERE society_id=? AND code=?',
          [id, 'E'],
        );
        assert.equal(
          Number(rolledBack[0]?.['total']),
          0,
          'Earlier wing must roll back on later conflict',
        );
        const [audits] = await db.execute<RowDataPacket[]>(
          'SELECT COUNT(*) AS total FROM audit_logs WHERE society_id=? AND action=?',
          [id, 'building.created'],
        );
        assert.equal(Number(audits[0]?.['total']), 4, 'Only committed wings are audited');
        const large = {
          revision: before,
          buildings: Array.from({ length: 5 }, (_, index) => ({
            code: 'L' + index,
            name: 'Large wing ' + index,
            flats: Array.from({ length: 100 }, (_, number) => ({
              number: String(number).padStart(32, '0'),
              areaSqFt: null,
            })),
          })),
        };
        assert.ok(Buffer.byteLength(JSON.stringify(large)) > 16 * 1024);
        assert.equal(
          (await platform.request(path, large)).status,
          201,
          'Maximum-size valid batch must fit its bounded JSON parser',
        );
        assert.equal(
          (
            await platform.request(path, {
              revision: before,
              buildings: [],
              padding: 'x'.repeat(129 * 1024),
            })
          ).status,
          413,
        );

        clockOffset += 60_000;
      },
    );
    await suite.test(
      'row houses reuse a scoped group and roll back duplicate ranges with revision and security checks',
      async () => {
        clockOffset += 60_000;
        const id = await create('STEP4_HOUSES');
        const path = '/platform/societies/' + id + '/row-houses';
        const houses = (numbers: string[]) => numbers.map((number) => ({ number, areaSqFt: null }));
        let body = {
          revision: await revision(platform, id),
          houses: houses(['1', '2', '3', '4', '5']),
        };
        assert.equal((await platform.request(path, body)).status, 409);
        await transition(id, 'SETUP_IN_PROGRESS');
        body = { ...body, revision: await revision(platform, id) };
        assert.equal((await anonymous.request(path, body)).status, 401);
        assert.equal((await outsider.request(path, body)).status, 403);
        assert.equal(
          (await outsider.request('/onboarding/societies/' + id + '/row-houses', body)).status,
          404,
        );
        assert.equal(
          (await platform.request(path, body, { 'X-CSRF-Token': 'forged' })).status,
          403,
        );
        assert.equal((await platform.request(path, { ...body, societyId: society })).status, 400);
        const results = await Promise.all([
          platform.request(path, body),
          platform.request(path, body),
        ]);
        assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
        const before = await revision(platform, id);
        assert.equal(
          (await platform.request(path, { revision: before, houses: houses(['6', '5']) })).status,
          409,
        );
        assert.equal(await revision(platform, id), before);
        assert.equal(
          (await platform.request(path, { revision: before, houses: houses(['6', '7']) })).status,
          201,
        );
        const [groups] = await db.execute<RowDataPacket[]>(
          'SELECT COUNT(*) AS total FROM buildings WHERE society_id=? AND code=?',
          [id, 'ROW_HOUSES'],
        );
        assert.equal(Number(groups[0]?.['total']), 1);
        const [units] = await db.execute<RowDataPacket[]>(
          'SELECT COUNT(*) AS total FROM flats WHERE society_id=?',
          [id],
        );
        assert.equal(Number(units[0]?.['total']), 7);
        const [audits] = await db.execute<RowDataPacket[]>(
          'SELECT COUNT(*) AS total FROM audit_logs WHERE society_id=? AND action=?',
          [id, 'building.created'],
        );
        assert.equal(Number(audits[0]?.['total']), 2);
        const large = {
          revision: await revision(platform, id),
          houses: Array.from({ length: 200 }, (_, n) => ({
            number: '漢'.repeat(29) + String(n).padStart(3, '0'),
            areaSqFt: '99999999.99',
          })),
        };
        assert.ok(Buffer.byteLength(JSON.stringify(large)) > 16 * 1024);
        assert.equal(
          (await platform.request(path, large)).status,
          201,
          'All 200 houses must fit the bounded request parser',
        );
        const afterLarge = await revision(platform, id);
        assert.equal(
          (
            await platform.request(path, {
              revision: afterLarge,
              houses: [...large.houses, { number: '208', areaSqFt: '99999999.99' }],
            })
          ).status,
          400,
        );
        assert.equal(await revision(platform, id), afterLarge);
        const [allUnits] = await db.execute<RowDataPacket[]>(
          'SELECT COUNT(*) AS total FROM flats WHERE society_id=?',
          [id],
        );
        assert.equal(Number(allUnits[0]?.['total']), 207);
        assert.equal(
          (await platform.request(path, { ...large, padding: 'x'.repeat(33 * 1024) })).status,
          413,
        );
        clockOffset += 60_000;
      },
    );
    await suite.test(
      'invitation hashes only; reissue revokes old token; acceptance is single-use and creates a separate global account',
      async () => {
        const body = {
          revision: await revision(platform, society),
          email: 'step4-committee@example.invalid',
          displayName: 'Initial Committee',
        };
        const sent = await platform.request(
          '/platform/societies/' + society + '/committee-invitations',
          body,
        );
        assert.equal(sent.status, 202);
        await queue.idle();
        const old = token();
        const retried = await platform.request(
          '/platform/societies/' + society + '/committee-invitations',
          { ...body, revision: await revision(platform, society) },
        );
        assert.equal(retried.status, 202);
        await queue.idle();
        currentToken = token();
        assert.notEqual(currentToken, old);
        assert.equal(
          (await anonymous.request('/onboarding/invitations/inspect', { token: old })).status,
          400,
        );
        await db.execute(
          'UPDATE society_setup_invitations SET expires_at=UTC_TIMESTAMP(6) WHERE society_id=? AND token_hash=?',
          [society, tokenHash(currentToken)],
        );
        assert.equal(
          (await anonymous.request('/onboarding/invitations/inspect', { token: currentToken }))
            .status,
          400,
        );
        assert.equal(
          (
            await anonymous.request('/onboarding/invitations/accept', {
              token: currentToken,
              password,
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await platform.request('/platform/societies/' + society + '/committee-invitations', {
              ...body,
              revision: await revision(platform, society),
            })
          ).status,
          202,
        );
        await queue.idle();
        currentToken = token();
        const preview = await anonymous.request('/onboarding/invitations/inspect', {
          token: currentToken,
        });
        assert.equal(preview.status, 200);
        assert.equal(preview.data['requiresLogin'], false);
        assert.equal(
          (
            await anonymous.request('/onboarding/invitations/accept', {
              token: currentToken,
              password,
            })
          ).status,
          204,
        );
        assert.equal(
          (
            await anonymous.request('/onboarding/invitations/accept', {
              token: currentToken,
              password,
            })
          ).status,
          400,
        );
        const [stored] = await db.execute<RowDataPacket[]>(
          'SELECT token_hash,status,accepted_by_user_id FROM society_setup_invitations WHERE society_id=? ORDER BY id DESC LIMIT 1',
          [society],
        );
        assert.deepEqual(stored[0]?.['token_hash'], tokenHash(currentToken));
        assert.equal(stored[0]?.['status'], 'ACCEPTED');
        assert.equal((await anonymous.request('/auth/session')).status, 401);
        await committee.login('step4-committee@example.invalid', password);
        const identity = await committee.request('/auth/session');
        assert.deepEqual(identity.data['memberships'], []);
        assert.ok(Array.isArray(identity.data['setupSocieties']));
        assert.equal(identity.data['setupSocieties'].length, 1);
        assert.equal((await committee.request('/society/access')).status, 403);
        assert.equal((await committee.request('/platform/dashboard')).status, 403);
      },
    );
    await suite.test(
      'setup rights are membership-scoped; foreign setup and private platform reads fail identically',
      async () => {
        assert.equal((await outsider.request('/onboarding/societies/' + society)).status, 404);
        assert.equal((await outsider.request('/onboarding/societies/999999')).status, 404);
        assert.equal(
          (await platform.request('/onboarding/societies/' + society + '/residents')).status,
          404,
        );
        assert.equal(
          (await platform.request('/onboarding/societies/' + society + '/maintenance')).status,
          404,
        );
        assert.equal(
          (await committee.request('/onboarding/societies/' + society + '/residents?pageSize=50'))
            .status,
          400,
        );
        assert.equal((await platform.request('/society/access')).status, 403);
        assert.equal(
          (
            await committee.request('/onboarding/societies/' + society + '/activate/confirm', {
              revision: await revision(committee, society, 'onboarding'),
              confirmed: true,
            })
          ).status,
          409,
        );
      },
    );
    await suite.test(
      'concurrent/stale setup submissions serialize and duplicates roll back',
      async () => {
        const r = await revision(platform, society);
        const body = {
          revision: r,
          code: 'A',
          name: 'Building A',
          flats: [{ number: '101', areaSqFt: '900.00' }],
        };
        const responses = await Promise.all([
          platform.request('/platform/societies/' + society + '/buildings', body),
          platform.request('/platform/societies/' + society + '/buildings', body),
        ]);
        assert.deepEqual(responses.map((v) => v.status).sort(), [201, 409]);
        assert.equal(responses.find((v) => v.status === 201)?.raw, '');
        assert.equal(
          (
            await platform.request('/platform/societies/' + society + '/buildings', {
              ...body,
              revision: await revision(platform, society),
            })
          ).status,
          409,
        );
        const structure = await committee.request(
          '/onboarding/societies/' + society + '/structure',
        );
        assert.equal(structure.status, 200);
        const [flats] = await db.execute<RowDataPacket[]>(
          'SELECT id FROM flats WHERE society_id=?',
          [society],
        );
        assert.equal(flats.length, 1);
        flat = String(flats[0]?.['id']);
        assert.equal(
          (
            await platform.request('/platform/societies/' + society + '/buildings', {
              revision: await revision(platform, society),
              code: 'B',
              name: 'Second building',
              flats: Array.from({ length: 51 }, (_, index) => ({
                number: String(index + 201),
                areaSqFt: '900.00',
              })),
            })
          ).status,
          201,
        );
        const firstPage = await committee.request(
          '/onboarding/societies/' + society + '/structure?page=1',
        );
        const nextPage = await committee.request(
          '/onboarding/societies/' + society + '/structure?page=2',
        );
        assert.equal(firstPage.status, 200);
        assert.equal(nextPage.status, 200);
        assert.ok(Array.isArray(firstPage.data['items']));
        assert.ok(Array.isArray(nextPage.data['items']));
        assert.equal(firstPage.data['items'].length, 50);
        assert.equal(nextPage.data['items'].length, 2);
        assert.equal(firstPage.data['total'], 52);
        assert.equal(
          (await committee.request('/onboarding/societies/' + society + '/structure?sort=password'))
            .status,
          400,
        );
      },
    );
    await suite.test(
      'initial person-only occupancy and decimal charge stay private; confirmations are explicit',
      async () => {
        const invalid = await committee.request('/onboarding/societies/' + society + '/residents', {
          revision: await revision(committee, society, 'onboarding'),
          flatId: flat,
          displayName: 'PRIVATE STEP4 RESIDENT',
          occupancyType: 'OWNER',
          startsOn: '2026-02-01',
          endsOn: '2026-01-01',
        });
        assert.equal(invalid.status, 400);
        assert.equal(
          (
            await committee.request('/onboarding/societies/' + society + '/residents', {
              revision: await revision(committee, society, 'onboarding'),
              flatId: flat,
              displayName: 'PRIVATE STEP4 RESIDENT',
              occupancyType: 'OWNER',
              startsOn: '2026-01-01',
              endsOn: null,
            })
          ).status,
          201,
        );
        assert.equal(
          (
            await committee.request('/onboarding/societies/' + society + '/residents/confirm', {
              revision: await revision(committee, society, 'onboarding'),
              confirmed: true,
            })
          ).status,
          204,
        );
        assert.equal(
          (
            await committee.request('/onboarding/societies/' + society + '/maintenance', {
              revision: await revision(committee, society, 'onboarding'),
              code: 'BASE',
              name: 'Private charge',
              method: 'PER_SQ_FT',
              rate: '100.25',
              effectiveFrom: '2026-01-01',
            })
          ).status,
          201,
        );
        assert.equal(
          (
            await committee.request('/onboarding/societies/' + society + '/maintenance/confirm', {
              revision: await revision(committee, society, 'onboarding'),
              confirmed: true,
            })
          ).status,
          204,
        );
        const privateCharges = await committee.request(
          '/onboarding/societies/' + society + '/maintenance',
        );
        assert.equal(privateCharges.status, 200);
        assert.match(privateCharges.raw, /"100.25"/);
        const publicDetail = await platform.request('/platform/societies/' + society);
        assert.equal(publicDetail.raw.includes('PRIVATE STEP4 RESIDENT'), false);
        assert.equal(publicDetail.raw.includes('100.25'), false);
        assert.equal(publicDetail.raw.includes(currentToken), false);
        const [counts] = await db.execute<RowDataPacket[]>(
          "SELECT COUNT(*) AS total FROM persons p JOIN society_persons sp ON sp.person_id=p.id WHERE sp.society_id=? AND sp.display_name='PRIVATE STEP4 RESIDENT' AND NOT EXISTS(SELECT 1 FROM users u WHERE u.person_id=p.id)",
          [society],
        );
        assert.equal(Number(counts[0]?.['total']), 1);
      },
    );
    await suite.test(
      'committee review binds current revision; platform cannot activate; verifier and immutable audits are recorded',
      async () => {
        assert.equal((await transition(society, 'PENDING_VERIFICATION')).status, 204);
        assert.equal((await transition(society, 'ACTIVE')).status, 403);
        const r = await revision(committee, society, 'onboarding');
        assert.equal(
          (
            await committee.request('/onboarding/societies/' + society + '/activate/confirm', {
              revision: r,
              confirmed: true,
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await committee.request('/onboarding/societies/' + society + '/review/confirm', {
              revision: r,
              confirmed: true,
            })
          ).status,
          204,
        );
        const outcomes = await Promise.all([
          committee.request('/onboarding/societies/' + society + '/activate/confirm', {
            revision: r,
            confirmed: true,
          }),
          committee.request('/onboarding/societies/' + society + '/activate/confirm', {
            revision: r,
            confirmed: true,
          }),
        ]);
        assert.deepEqual(outcomes.map((v) => v.status).sort(), [204, 409]);
        const activated = await detail(platform, society);
        assert.equal(activated['status'], 'ACTIVE');
        assert.equal(typeof activated['verifiedAt'], 'string');
        assert.equal(typeof activated['verifierMembershipId'], 'string');
        const [events] = await db.execute<RowDataPacket[]>(
          "SELECT COUNT(*) AS total FROM audit_logs WHERE society_id=? AND action='society.activated'",
          [society],
        );
        assert.equal(Number(events[0]?.['total']), 1);
        await assert.rejects(
          db.execute('UPDATE society_onboarding_events SET revision=revision WHERE society_id=?', [
            society,
          ]),
        );
        await assert.rejects(
          db.execute('DELETE FROM society_onboarding_events WHERE society_id=?', [society]),
        );
        await assert.rejects(
          db.execute(
            'UPDATE society_onboarding SET verified_at=UTC_TIMESTAMP(6) WHERE society_id=?',
            [society],
          ),
        );
        const identity = await committee.request('/auth/session');
        assert.ok(Array.isArray(identity.data['memberships']));
        assert.equal(identity.data['memberships'].length, 1);
        assert.deepEqual(identity.data['setupSocieties'], []);
      },
    );
    await suite.test(
      'suspension/resume/deactivation preserve verification and prohibit edits and terminal revival',
      async () => {
        const before = await detail(platform, society);
        assert.equal((await transition(society, 'SUSPENDED')).status, 204);
        assert.equal(
          (
            await committee.request('/onboarding/societies/' + society + '/residents/confirm', {
              revision: before['revision'],
              confirmed: true,
            })
          ).status,
          409,
        );
        assert.equal((await transition(society, 'ACTIVE')).status, 204);
        assert.equal(
          (
            await platform.request('/platform/societies/' + society + '/status', {
              revision: before['revision'],
              fromStatus: 'SUSPENDED',
              status: 'DEACTIVATED',
            })
          ).status,
          409,
        );
        assert.equal((await transition(society, 'DEACTIVATED')).status, 204);
        assert.equal((await transition(society, 'ACTIVE')).status, 409);
        assert.equal((await detail(platform, society))['verifiedAt'], before['verifiedAt']);
        await assert.rejects(
          db.execute("UPDATE societies SET status='ACTIVE' WHERE id=?", [society]),
        );
      },
    );
    await suite.test(
      'existing invitees require their own login and reuse global identity; role revocation denies next setup request',
      async () => {
        const other = await create('STEP4_B');
        assert.equal((await transition(other, 'SETUP_IN_PROGRESS')).status, 204);
        assert.equal(
          (
            await platform.request('/platform/societies/' + other + '/committee-invitations', {
              revision: await revision(platform, other),
              email: 'step4-existing@example.invalid',
              displayName: 'Existing global user',
            })
          ).status,
          202,
        );
        await queue.idle();
        const invitation = token();
        assert.equal(
          (
            await anonymous.request('/onboarding/invitations/accept', {
              token: invitation,
              password,
            })
          ).status,
          403,
        );
        const existing = new AuthClient(base, auth.config.origin);
        await existing.login('step4-existing@example.invalid', password);
        assert.equal(
          (await existing.request('/onboarding/invitations/accept', { token: invitation })).status,
          204,
        );
        const [users] = await db.execute<RowDataPacket[]>(
          'SELECT id FROM users WHERE email_normalized=?',
          ['step4-existing@example.invalid'],
        );
        assert.equal(users.length, 1);
        assert.equal(String(users[0]?.['id']), String(existingUser));
        await db.execute(
          "UPDATE society_memberships SET status='SUSPENDED' WHERE society_id=? AND user_id=?",
          [other, existingUser],
        );
        assert.equal((await existing.request('/onboarding/societies/' + other)).status, 404);
        await db.execute('DELETE FROM platform_user_roles WHERE user_id=?', [platformUser]);
        assert.equal((await platform.request('/platform/dashboard')).status, 403);
      },
    );
    assert.deepEqual(logs, []);
  } finally {
    await queue.idle();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    await database.pool.end();
  }
}
