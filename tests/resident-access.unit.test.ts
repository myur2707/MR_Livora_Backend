import assert from 'node:assert/strict';
import test from 'node:test';
import {
  signupSchema,
  joinSchema,
  inviteSchema,
  acceptanceSchema,
  approvalSchema,
  joinSocietyOptionsSchema,
  joinPropertyOptionsSchema,
} from '../src/resident-access/contracts.js';
void test('resident boundary rejects protected identifiers, roles and identity changes', () => {
  const join = {
    societyCode: 'PUBLIC_CODE',
    buildingCode: 'A',
    flatNumber: '101',
    occupancyType: 'TENANT',
    displayName: 'Synthetic resident',
    contactPhone: null,
    note: null,
  };
  assert.equal(joinSchema.safeParse(join).success, true);
  for (const field of ['societyId', 'userId', 'personId', 'role', 'actor_user_id'])
    assert.equal(joinSchema.safeParse({ ...join, [field]: '1' }).success, false);
  assert.equal(
    inviteSchema.safeParse({
      personId: '1',
      flatId: '2',
      confirmed: true,
      email: 'replacement@example.invalid',
    }).success,
    false,
  );
});
void test('join option searches are bounded, scoped and reject extra fields', () => {
  assert.deepEqual(joinSocietyOptionsSchema.parse({ search: '  township  ' }), {
    search: 'township',
  });
  assert.deepEqual(joinPropertyOptionsSchema.parse({ societyCode: 'ACTIVE_ONE' }), {
    societyCode: 'ACTIVE_ONE',
    search: '',
  });
  assert.equal(
    joinPropertyOptionsSchema.safeParse({ societyCode: 'ACTIVE_ONE', societyId: '1' }).success,
    false,
  );
  assert.equal(joinSocietyOptionsSchema.safeParse({ search: 'x'.repeat(81) }).success, false);
});
void test('approval requires explicit verification and valid dates, not an applicant claim', () => {
  const value = {
    confirmed: true,
    note: 'Identity and tenancy verified',
    personId: null,
    flatId: '1',
    existingOccupancyId: null,
    occupancyType: 'TENANT',
    startsOn: '2026-10-01',
    endsOn: null,
  };
  assert.equal(approvalSchema.safeParse(value).success, true);
  for (const invalid of [
    { confirmed: false },
    { note: '' },
    { startsOn: '2026-02-30' },
    { endsOn: '2026-09-30' },
    { role: 'COMMITTEE_ADMIN' },
  ])
    assert.equal(approvalSchema.safeParse({ ...value, ...invalid }).success, false);
});
void test('signup and acceptance bound passwords, normalize emails and validate token format', () => {
  assert.equal(
    signupSchema.parse({
      email: ' New@Example.invalid ',
      displayName: 'Resident',
      password: 'Synthetic password length',
    }).email,
    'new@example.invalid',
  );
  assert.equal(
    signupSchema.safeParse({
      email: 'a@example.invalid',
      displayName: 'Resident',
      password: 'short',
    }).success,
    false,
  );
  assert.equal(
    acceptanceSchema.safeParse({ token: 'x'.repeat(43), societyId: '2' }).success,
    false,
  );
  assert.equal(acceptanceSchema.safeParse({ token: '../token' }).success, false);
});
