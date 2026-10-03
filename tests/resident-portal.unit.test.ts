import assert from 'node:assert/strict';
import test from 'node:test';
import { parse, pageQuery, billQuery, complaintInput } from '../src/resident-portal/contracts.js';
import { flatPolicy } from '../src/resident-portal/access.js';
void test('resident requests allowlist fields and constrain identifiers, pagination and complaint content', () => {
  assert.deepEqual(parse(pageQuery, {}), { page: 1, pageSize: 20 });
  for (const extra of [
    { societyId: '1' },
    { userId: '1' },
    { sort: 'DROP' },
    { pageSize: '51' },
    { page: '0' },
  ])
    assert.throws(() => parse(pageQuery, extra));
  assert.throws(() => parse(billQuery, { flatId: '0' }));
  assert.throws(() => parse(billQuery, { status: 'DRAFT' }));
  const fields = { flatId: '1', title: ' Plumbing ', description: 'First line\nSecond line' };
  assert.equal(parse(complaintInput, fields).title, 'Plumbing');
  for (const extra of [
    { status: 'CLOSED' },
    { submittedByMembershipId: '2' },
    { societyId: '1' },
    { description: '' },
    { title: '\u0000' },
  ])
    assert.throws(() => parse(complaintInput, { ...fields, ...extra }));
});
void test('current occupancy and bill-period restrictions are independent parameterized predicates', () => {
  const scope = {
    societyId: '1',
    membershipId: '2',
    userId: '3',
    personId: '4',
    societyName: 'Synthetic',
    timezone: 'Asia/Kolkata',
    today: '2026-10-03',
  };
  const current = flatPolicy(scope);
  const bill = flatPolicy(scope, true);
  assert.deepEqual(current.values, ['4', '2026-10-03', '2026-10-03']);
  assert.match(current.sql, /o\.starts_on<=\?/);
  assert.match(current.sql, /o\.ends_on>=\?/);
  assert.match(bill.sql, /p\.starts_on>=o\.starts_on/);
  assert.match(bill.sql, /p\.starts_on<=o\.ends_on/);
  assert.doesNotMatch(current.sql, /2026-10-03/);
});
