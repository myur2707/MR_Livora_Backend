import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { TestContext } from 'node:test';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { openRuntime } from '../src/database/runtime.js';
import { AuthRepository } from '../src/auth/repository.js';
import { AuthService } from '../src/auth/service.js';
import { ResetQueue } from '../src/auth/reset-queue.js';
import { hashPassword } from '../src/auth/crypto.js';
import { PropertyAccess } from '../src/property/access.js';
import { PropertyService } from '../src/property/service.js';
import { OccupancyService } from '../src/property/occupancies.js';
import { ImportService } from '../src/property/imports/service.js';
import { createApp } from '../src/http/app.js';
import { AuthClient } from './auth-client.js';
import { createFixture, insert } from './fixtures.js';
import { grantTestRuntime } from './runtime-provision.js';
export async function propertyIntegration(suite: TestContext, db: Connection): Promise<void> {
  const password = 'Synthetic property password';
  const encoded = await hashPassword(password);
  async function account(email: string) {
    const person = await insert(db, 'INSERT INTO persons() VALUES()');
    const user = await insert(
      db,
      "INSERT INTO users(person_id,email_normalized,password_hash,status) VALUES(?,?,?,'ACTIVE')",
      [person, email, encoded],
    );
    return { person, user };
  }
  const admin = await account('step5-admin@example.invalid');
  const foreign = await account('step5-foreign@example.invalid');
  const resident = await account('step5-resident@example.invalid');
  const platform = await account('step5-platform@example.invalid');
  const a = await createFixture(db, 'STEP5_A', admin.user, admin.person, 'COMMITTEE_ADMIN');
  const b = await createFixture(db, 'STEP5_B', foreign.user, foreign.person, 'COMMITTEE_ADMIN');
  const c = await createFixture(db, 'STEP5_C', resident.user, resident.person, 'RESIDENT');
  await db.execute("UPDATE societies SET status='ACTIVE' WHERE id IN(?,?,?)", [
    a.society,
    b.society,
    c.society,
  ]);
  const [permissions] = await db.execute<RowDataPacket[]>(
    "SELECT id FROM permissions WHERE code='society.members.manage'",
  );
  const permission = String(permissions[0]?.['id']);
  for (const f of [a, b])
    await db.execute(
      'INSERT INTO role_permissions(society_id,role_id,permission_id) VALUES(?,?,?)',
      [f.society, f.role, permission],
    );
  await db.execute(
    "INSERT INTO platform_user_roles(user_id,role_code) VALUES(?,'PLATFORM_ADMIN')",
    [platform.user],
  );
  await grantTestRuntime();
  const database = await openRuntime(process.env);
  const logs: string[] = [];
  const queue = new ResetQueue((code) => logs.push(code));
  const auth = await AuthService.create(
    new AuthRepository(database),
    {
      origin: 'http://127.0.0.1:4200',
      secret: 'e'.repeat(64),
      secure: false,
      cookieName: 'livora_session',
      idleMs: 1800000,
      absoluteMs: 43200000,
      resetMs: 1800000,
    },
    { send: () => Promise.resolve() },
    queue,
  );
  const service = new PropertyService(new PropertyAccess(database));
  const occupancy = new OccupancyService(service);
  const imports = new ImportService(service, occupancy);
  const server = createApp(auth, (code) => logs.push(code), undefined, undefined, {
    service,
    occupancy,
    imports,
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = 'http://127.0.0.1:' + address.port;
  const client = new AuthClient(base, auth.config.origin);
  const other = new AuthClient(base, auth.config.origin);
  const ordinary = new AuthClient(base, auth.config.origin);
  const root = new AuthClient(base, auth.config.origin);
  const get = async (path: string) => {
    const r = await client.request('/society/' + path);
    assert.equal(r.status, 200, r.raw);
    return r.data;
  };
  const post = async (path: string, body: unknown, status = 201) => {
    const r = await client.request('/society/' + path, body);
    assert.equal(r.status, status, r.raw);
    return r.data;
  };
  const preview = async (csv: string, type = 'FLATS', replaceBatchId?: string) =>
    post('imports/preview', {
      importType: type,
      fileName: 'test.csv',
      csv,
      ...(replaceBatchId ? { replaceBatchId } : {}),
    });
  const confirm = async (batch: Record<string, unknown>, status = 200) =>
    post(
      'imports/' + String(batch['id']) + '/confirm',
      {
        sourceHash: batch['sourceHash'],
        reviewHash: batch['reviewHash'],
        confirmed: true,
        acknowledgeWarnings: true,
      },
      status,
    );
  const flatHeader = 'building_code,building_name,flat_number,area_sq_ft\n';
  const residentHeader =
    'person_reference,display_name,contact_email,contact_phone,building_code,flat_number,occupancy_type,starts_on,ends_on\n';
  let personId = '';
  let flatId = '';
  let buildingId = '';
  try {
    await client.login('step5-admin@example.invalid', password);
    await other.login('step5-foreign@example.invalid', password);
    await ordinary.login('step5-resident@example.invalid', password);
    await root.login('step5-platform@example.invalid', password);
    for (const [cl, f] of [
      [client, a],
      [other, b],
      [ordinary, c],
    ] as const)
      assert.equal(
        (await cl.request('/auth/society-context', { societyId: String(f.society) })).status,
        204,
      );
    await suite.test(
      'tenant authorization, scope, strict pagination, CSRF and mass assignment',
      async () => {
        for (const cl of [ordinary, root])
          assert.equal((await cl.request('/society/persons')).status, 403);
        for (const path of [
          'flats/' + b.flat,
          'flats/999999',
          'persons/' + foreign.person,
          'buildings/' + b.building,
        ])
          assert.equal((await client.request('/society/' + path)).status, 404);
        for (const q of [
          '?sort=password_hash',
          '?societyId=' + b.society,
          '?pageSize=51',
          '?page=0',
        ])
          assert.equal((await client.request('/society/flats' + q)).status, 400);
        assert.equal(
          (
            await client.request('/society/buildings', {
              code: 'X',
              name: 'X',
              societyId: String(b.society),
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await client.request(
              '/society/buildings',
              { code: 'X', name: 'X' },
              { 'X-CSRF-Token': 'invalid' },
            )
          ).status,
          403,
        );
        assert.equal((await get('flats?pageSize=1'))['pageSize'], 1);
      },
    );
    await suite.test(
      'create/edit/archive resources, optimistic conflicts and reserved duplicate keys',
      async () => {
        buildingId = String(
          (await post('buildings', { code: 'MANAGED', name: 'Managed block' }))['id'],
        );
        flatId = String(
          (await post('flats', { buildingId, flatNumber: '501', areaSqFt: '1234.50' }))['id'],
        );
        await post('flats', { buildingId, flatNumber: '501', areaSqFt: null }, 409);
        personId = String(
          (
            await post('persons', {
              displayName: 'Same Name',
              contactEmail: null,
              contactPhone: '1234567890',
              reference: 'RES_001',
            })
          )['id'],
        );
        const second = await post('persons', {
          displayName: 'Same Name',
          contactEmail: null,
          contactPhone: '1234567890',
          reference: 'RES_002',
        });
        assert.notEqual(second['id'], personId);
        const [users] = await db.execute<RowDataPacket[]>(
          'SELECT id FROM users WHERE person_id=?',
          [personId],
        );
        assert.equal(users.length, 0);
        const before = await get('buildings/' + buildingId);
        const put = async (version: unknown) =>
          fetch(base + '/api/v1/society/buildings/' + buildingId, {
            method: 'PUT',
            headers: {
              Cookie: client.cookie,
              Origin: client.origin,
              'Content-Type': 'application/json',
              'X-CSRF-Token': client.csrf,
            },
            body: JSON.stringify({ code: 'MANAGED', name: 'Updated managed block', version }),
          });
        assert.equal((await put(before['version'])).status, 204);
        assert.equal((await put(before['version'])).status, 409);
        await post(
          'buildings/' + buildingId + '/archive',
          { version: (await get('buildings/' + buildingId))['version'] },
          409,
        );
        const empty = String(
          (await post('buildings', { code: 'EMPTY', name: 'Empty block' }))['id'],
        );
        await post(
          'buildings/' + empty + '/archive',
          { version: (await get('buildings/' + empty))['version'] },
          204,
        );
        assert.equal((await get('buildings?state=archived'))['total'], 1);
        await post('buildings', { code: 'EMPTY', name: 'Reuse' }, 409);
      },
    );

    await suite.test(
      'flat/profile edits are versioned and tenant scoped; archives retain historical links',
      async () => {
        const edit = async (path: string, body: unknown) =>
          fetch(base + '/api/v1/society/' + path, {
            method: 'PUT',
            headers: {
              Cookie: client.cookie,
              Origin: client.origin,
              'Content-Type': 'application/json',
              'X-CSRF-Token': client.csrf,
            },
            body: JSON.stringify(body),
          });
        const current = await get('flats/' + flatId);
        const body = {
          buildingId,
          flatNumber: '501',
          areaSqFt: '1400.25',
          version: current['version'],
        };
        assert.equal((await edit('flats/' + flatId, body)).status, 204);
        assert.equal((await edit('flats/' + flatId, body)).status, 409);
        assert.equal((await get('flats/' + flatId))['areaSqFt'], '1400.25');
        assert.equal((await edit('flats/' + b.flat, body)).status, 404);
        assert.equal(
          (
            await edit('flats/' + flatId, {
              ...body,
              version: (await get('flats/' + flatId))['version'],
              buildingId: String(b.building),
            })
          ).status,
          404,
        );
        const profile = await get('persons/' + personId);
        const update = {
          displayName: 'Same Name',
          contactEmail: 'private@example.invalid',
          contactPhone: '1234567890',
          reference: 'RES_001',
          version: profile['version'],
        };
        assert.equal((await edit('persons/' + personId, update)).status, 204);
        assert.equal(
          (
            await edit('persons/' + personId, {
              ...update,
              version: (await get('persons/' + personId))['version'],
              reference: 'REASSIGNED',
            })
          ).status,
          409,
        );
        const archivedPerson = String(
          (
            await post('persons', {
              displayName: 'Archive subject',
              contactEmail: null,
              contactPhone: null,
              reference: 'ARCHIVE_001',
            })
          )['id'],
        );
        await post(
          'persons/' + archivedPerson + '/archive',
          { version: (await get('persons/' + archivedPerson))['version'] },
          204,
        );
        assert.equal((await get('persons?state=archived'))['total'], 1);
        const tempFlat = String(
          (await post('flats', { buildingId, flatNumber: 'EMPTY', areaSqFt: null }))['id'],
        );
        await post(
          'flats/' + tempFlat + '/archive',
          { version: (await get('flats/' + tempFlat))['version'] },
          204,
        );
        assert.equal((await get('flats?state=archived'))['total'], 1);
        await post('flats', { buildingId, flatNumber: 'EMPTY', areaSqFt: null }, 409);
      },
    );
    await suite.test(
      'owner and tenant coexist; historical, inclusive overlap and concurrent duplicate protection',
      async () => {
        await post('flats/' + flatId + '/occupancies', {
          personId,
          occupancyType: 'OWNER',
          startsOn: '2020-01-01',
          endsOn: null,
        });
        await post('flats/' + flatId + '/occupancies', {
          personId,
          occupancyType: 'TENANT',
          startsOn: '2021-01-01',
          endsOn: '2022-01-01',
        });
        const body = { personId, occupancyType: 'TENANT', startsOn: '2023-01-01', endsOn: null };
        const results = await Promise.all([
          client.request('/society/flats/' + flatId + '/occupancies', body),
          client.request('/society/flats/' + flatId + '/occupancies', body),
        ]);
        assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
        await post(
          'flats/' + flatId + '/occupancies',
          { ...body, personId: String(foreign.person) },
          404,
        );
        await post('flats/' + flatId + '/occupancies', { ...body, endsOn: '2022-01-01' }, 400);
        await post(
          'flats/' + flatId + '/archive',
          { version: (await get('flats/' + flatId))['version'] },
          409,
        );
        const history = await get('flats/' + flatId + '/occupancies?filter=history');
        assert.equal(history['total'], 1);
        const current = await get('flats/' + flatId + '/occupancies?filter=current');
        assert.equal(current['total'], 2);
        assert.ok(Array.isArray(current['items']));
        const currentItems: unknown[] = current['items'];
        for (const row of currentItems) {
          assert.ok(typeof row === 'object' && row !== null && 'id' in row && 'version' in row);
          await post(
            'flats/' + flatId + '/occupancies/' + String(row.id) + '/close',
            { version: row.version, endsOn: '2025-12-31' },
            204,
          );
        }
        assert.equal((await get('flats/' + flatId + '/occupancies?filter=history'))['total'], 3);
        await assert.rejects(
          db.execute('UPDATE flat_occupancies SET ends_on=? WHERE society_id=? AND person_id=?', [
            '2026-01-01',
            a.society,
            personId,
          ]),
        );
        await assert.rejects(
          db.execute('DELETE FROM flat_occupancies WHERE society_id=? AND person_id=?', [
            a.society,
            personId,
          ]),
        );
      },
    );
    await suite.test(
      'preview errors are row numbered, correction replaces staging, confirmation is atomic and idempotent',
      async () => {
        const bad = await preview(flatHeader + 'CSV,CSV block,901,-1\nCSV,CSV block,901,900.00');
        assert.ok(Number(bad['errorRows']) > 0);
        const rows = await get('imports/' + String(bad['id']) + '/rows');
        assert.ok(Array.isArray(rows['items']));
        assert.equal(
          (rows['items'] as unknown[]).map((row) => {
            assert.ok(typeof row === 'object' && row !== null && 'rowNumber' in row);
            return row.rowNumber;
          })[0],
          2,
        );
        await confirm(bad, 409);
        const good = await preview(
          flatHeader + 'CSV,CSV block,901,900.00\nCSV,CSV block,902,950.00',
          'FLATS',
          String(bad['id']),
        );
        assert.equal(good['errorRows'], 0);
        assert.equal((await get('flats?q=901'))['total'], 0);
        assert.equal((await other.request('/society/imports/' + String(good['id']))).status, 404);
        const done = await confirm(good);
        assert.equal(done['status'], 'CONFIRMED');
        assert.deepEqual(done['result'], { buildings: 1, flats: 2, persons: 0, occupancies: 0 });
        assert.deepEqual((await confirm(good))['result'], done['result']);
        const [staged] = await db.execute<RowDataPacket[]>(
          'SELECT row_data FROM society_import_rows WHERE society_id=? AND batch_id IN(?,?)',
          [a.society, String(bad['id']), String(good['id'])],
        );
        assert.ok(staged.every((r) => r['row_data'] === null));
        await assert.rejects(
          db.execute('UPDATE society_import_batches SET error_rows=0 WHERE id=?', [
            String(good['id']),
          ]),
        );
        const duplicate = await preview(flatHeader + 'CSV,CSV block,901,900.00');
        assert.equal(duplicate['errorRows'], 1);
      },
    );
    await suite.test(
      'explicit references reuse identity, similar names do not merge and changed review requires revalidation',
      async () => {
        const batch = await preview(
          residentHeader +
            'CSV_001,Same Name,,1234567890,CSV,901,TENANT,2020-01-01,2021-01-01\nCSV_001,Same Name,,1234567890,CSV,902,OWNER,2020-01-01,',
          'RESIDENTS',
        );
        assert.equal(batch['errorRows'], 0);
        assert.ok(Number(batch['warningRows']) > 0);
        await post(
          'imports/' + String(batch['id']) + '/confirm',
          {
            sourceHash: batch['sourceHash'],
            reviewHash: batch['reviewHash'],
            confirmed: true,
            acknowledgeWarnings: false,
          },
          409,
        );
        const done = await confirm(batch);
        assert.deepEqual(done['result'], { buildings: 0, flats: 0, persons: 1, occupancies: 2 });
        const another = await preview(
          residentHeader + 'CSV_001,Same Name,,1234567890,CSV,901,FAMILY_MEMBER,2022-01-01,',
          'RESIDENTS',
        );
        assert.deepEqual((await confirm(another))['result'], {
          buildings: 0,
          flats: 0,
          persons: 0,
          occupancies: 1,
        });
        const conflict = await preview(
          residentHeader + 'CSV_001,Different Name,,,CSV,901,TENANT,2022-01-01,',
          'RESIDENTS',
        );
        assert.equal(conflict['errorRows'], 1);
        const staged = await preview(flatHeader + 'LATE,Late block,1,900.00');
        const late = String((await post('buildings', { code: 'LATE', name: 'Late block' }))['id']);
        await post('flats', { buildingId: late, flatNumber: '1', areaSqFt: null });
        await confirm(staged, 409);
        const refreshed = await post('imports/' + String(staged['id']) + '/revalidate', {}, 200);
        assert.equal(refreshed['errorRows'], 1);
        await confirm(refreshed, 409);
        await post('imports/' + String(refreshed['id']) + '/cancel', {}, 204);
      },
    );
    await suite.test(
      'a failure after the first imported row rolls back every domain record and audit',
      async () => {
        await db.query(
          "CREATE TRIGGER test_import_failure BEFORE INSERT ON flats FOR EACH ROW BEGIN IF NEW.flat_number='FORCED_FAIL' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Synthetic transaction failure'; END IF; END",
        );
        const batch = await preview(
          flatHeader +
            'ROLLBACK,Rollback block,1,900.00\\nROLLBACK,Rollback block,FORCED_FAIL,900.00'.replaceAll(
              '\\n',
              '\n',
            ),
        );
        const response = await confirm(batch, 409);
        assert.ok(
          typeof response['error'] === 'object' &&
            response['error'] !== null &&
            'code' in response['error'] &&
            'message' in response['error'],
        );
        assert.equal(response['error'].code, 'IMPORT_ROW_CONFLICT');
        assert.match(String(response['error'].message), /CSV row 3/);
        assert.equal((await get('buildings?q=ROLLBACK'))['total'], 0);
        assert.equal((await get('imports/' + String(batch['id'])))['status'], 'REVIEW');
      },
    );
    await suite.test(
      'expired imports minimize PII and membership revocation denies the next request',
      async () => {
        const batch = await preview(flatHeader + 'EXPIRE,Expired,1,900.00');
        await db.execute('UPDATE society_import_batches SET created_at=?,expires_at=? WHERE id=?', [
          '2020-01-01',
          '2020-01-02',
          String(batch['id']),
        ]);
        await confirm(batch, 409);
        await imports.expire();
        const [rows] = await db.execute<RowDataPacket[]>(
          'SELECT row_data FROM society_import_rows WHERE batch_id=?',
          [String(batch['id'])],
        );
        assert.ok(rows.every((r) => r['row_data'] === null));
        await db.execute("UPDATE society_memberships SET status='SUSPENDED' WHERE id=?", [
          a.membership,
        ]);
        assert.equal((await client.request('/society/persons')).status, 403);
      },
    );
    assert.deepEqual(logs, []);
  } finally {
    await queue.idle();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    await database.pool.end();
  }
}
