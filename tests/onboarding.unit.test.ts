import assert from 'node:assert/strict';
import test from 'node:test';
import { ResetQueue } from '../src/auth/reset-queue.js';
import { assertTransition, assertComplete } from '../src/onboarding/policy.js';
import { ApiError } from '../src/http/errors.js';
import {
  identifier,
  parse,
  buildingSchema,
  buildingBatchSchema,
  rowHousesSchema,
  residentSchema,
  maintenanceSchema,
  createSocietySchema,
  pageSchema,
} from '../src/onboarding/contracts.js';
void test('identifiers reject malformed values before integer conversion and retain unsigned limits', () => {
  for (const value of [
    '1 OR 1=1',
    '1; SELECT password_hash FROM users',
    'text',
    '1.5',
    '1e2',
    '-1',
    '0',
    '01',
    '',
    '18446744073709551616',
    '9'.repeat(10000),
    1,
    null,
  ]) {
    assert.equal(identifier.safeParse(value).success, false);
    assert.throws(
      () => parse(identifier, value),
      (error: unknown) => error instanceof ApiError && error.status === 400,
    );
  }
  for (const value of ['1', '18446744073709551615']) assert.equal(identifier.parse(value), value);
});
void test('society lifecycle rejects jumps, terminal revival and repeated transitions', () => {
  for (const [from, to] of [
    ['DRAFT', 'ACTIVE'],
    ['DEACTIVATED', 'ACTIVE'],
    ['ACTIVE', 'DRAFT'],
    ['PENDING_VERIFICATION', 'PENDING_VERIFICATION'],
  ] as const)
    assert.throws(() => assertTransition(from, to));
  assert.doesNotThrow(() => assertTransition('DRAFT', 'SETUP_IN_PROGRESS'));
  assert.doesNotThrow(() => assertTransition('PENDING_VERIFICATION', 'ACTIVE'));
  assert.doesNotThrow(() => assertTransition('ACTIVE', 'SUSPENDED'));
});
void test('every activation requirement is mandatory, including explicit empty resident review', () => {
  const complete = {
    committee: true,
    buildings: true,
    flats: true,
    residents: true,
    maintenance: true,
  };
  assert.doesNotThrow(() => assertComplete(complete));
  for (const key of Object.keys(complete))
    assert.throws(() => assertComplete({ ...complete, [key]: false }));
});
void test('setup schemas reject impersonation, malformed dates/money, duplicate flats and unbounded pages', () => {
  const society = { code: 'TEST', name: 'Test society', timezone: 'Asia/Kolkata' };
  assert.deepEqual(parse(createSocietySchema, society), society);
  assert.throws(() => parse(createSocietySchema, { ...society, status: 'ACTIVE' }));
  assert.throws(() => parse(createSocietySchema, { ...society, timezone: 'unknown' }));
  assert.throws(() => parse(pageSchema, { pageSize: 100000 }));
  assert.throws(() => parse(pageSchema, { sort: 'password_hash' }));
  assert.throws(() =>
    parse(buildingSchema, {
      revision: '1',
      code: 'A',
      name: 'A',
      flats: [
        { number: '101', areaSqFt: null },
        { number: '101', areaSqFt: null },
      ],
    }),
  );
  const resident = {
    revision: '1',
    flatId: '1',
    displayName: 'Person without login',
    occupancyType: 'TENANT',
    startsOn: '2026-02-01',
    endsOn: '2026-01-01',
  };
  assert.throws(() => parse(residentSchema, resident));
  assert.throws(() => parse(residentSchema, { ...resident, startsOn: '2026-02-30', endsOn: null }));
  assert.throws(() =>
    parse(maintenanceSchema, {
      revision: '1',
      code: 'BASE',
      name: 'Base',
      method: 'FLAT_RATE',
      rate: 100,
      effectiveFrom: '2026-01-01',
    }),
  );
  assert.throws(() =>
    parse(maintenanceSchema, {
      revision: '1',
      code: 'BASE',
      name: 'Base',
      method: 'FLAT_RATE',
      rate: '-1.00',
      effectiveFrom: '2026-01-01',
    }),
  );
});
void test('bounded invitation queue reports overflow and delivery failures without exposing details', async () => {
  const logs: string[] = [];
  const queue = new ResetQueue((code) => logs.push(code));
  for (let i = 0; i < 32; i++)
    assert.equal(
      queue.enqueue(() => Promise.resolve(), 'synthetic'),
      true,
    );
  assert.equal(
    queue.enqueue(() => Promise.resolve(), 'synthetic'),
    false,
  );
  await queue.idle();
  assert.deepEqual(logs, ['RESET_QUEUE_FULL']);
  assert.equal(
    queue.enqueue(() => Promise.reject(new Error('private mail content')), 'synthetic'),
    true,
  );
  await queue.idle();
  assert.deepEqual(logs, ['RESET_QUEUE_FULL', 'RESET_DELIVERY_FAILED']);
});

void test('row houses validate bounded unique numbers and reject scope/group overrides', () => {
  const house = { number: '1', areaSqFt: null };
  const body = { revision: '1', houses: [house] };
  assert.deepEqual(parse(rowHousesSchema, body), body);
  const houses = Array.from({ length: 200 }, (_, n) => ({ ...house, number: String(n + 1) }));
  assert.equal(parse(rowHousesSchema, { ...body, houses }).houses.length, 200);
  assert.throws(() =>
    parse(buildingSchema, {
      revision: '1',
      code: 'A',
      name: 'Wing A',
      flats: houses.slice(0, 101),
    }),
  );
  for (const invalid of [
    { ...body, societyId: '2' },
    { ...body, code: 'A' },
    { ...body, houses: [] },
    { ...body, houses: [house, house] },
    { ...body, houses: [{ ...house, areaSqFt: '-1.00' }] },
    { ...body, houses: Array.from({ length: 201 }, (_, n) => ({ ...house, number: String(n) })) },
  ])
    assert.throws(() => parse(rowHousesSchema, invalid));
  assert.throws(() =>
    parse(buildingSchema, { revision: '1', code: 'row_houses', name: 'Wing', flats: [house] }),
  );
});

void test('wing batches bound work, reject duplicate codes and protected fields, and keep flat uniqueness within a wing', () => {
  const wing = { code: 'A', name: 'Wing A', flats: [{ number: '101', areaSqFt: null }] };
  const batch = { revision: '1', buildings: [wing, { ...wing, code: 'B' }] };
  assert.equal(parse(buildingBatchSchema, batch).buildings.length, 2);
  for (const invalid of [
    { ...batch, societyId: '2' },
    { ...batch, buildings: [] },
    { ...batch, buildings: [wing, { ...wing, code: 'a' }] },
    { ...batch, buildings: [{ ...wing, recordedBy: '1' }] },
    { ...batch, buildings: [{ ...wing, flats: [wing.flats[0], wing.flats[0]] }] },
    { ...batch, buildings: Array.from({ length: 11 }, (_, i) => ({ ...wing, code: String(i) })) },
    {
      ...batch,
      buildings: Array.from({ length: 6 }, (_, i) => ({
        ...wing,
        code: String(i),
        flats: Array.from({ length: 100 }, (_, n) => ({ number: String(n), areaSqFt: null })),
      })),
    },
  ])
    assert.throws(() => parse(buildingBatchSchema, invalid));
});
