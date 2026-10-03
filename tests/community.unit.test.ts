import assert from 'node:assert/strict';
import test from 'node:test';
import { canTransition, statuses } from '../src/community/policy.js';
import {
  noticeInput,
  noticeEdit,
  complaintAction,
  complaintQuery,
  parse,
} from '../src/community/contracts.js';
import { complaintInput } from '../src/resident-portal/contracts.js';
void test('complaints follow the documented sequence with terminal closure', () => {
  for (const [from, to] of [
    ['NEW', 'ASSIGNED'],
    ['ASSIGNED', 'IN_PROGRESS'],
    ['IN_PROGRESS', 'RESOLVED'],
    ['RESOLVED', 'CLOSED'],
  ] as const)
    assert.equal(canTransition(from, to), true);
  for (const status of statuses) {
    assert.equal(canTransition('CLOSED', status), false);
    assert.equal(canTransition(status, status), false);
  }
  assert.equal(canTransition('NEW', 'RESOLVED'), false);
});
void test('community schemas reject mass assignment, invalid categories, controls and revisions', () => {
  const fields = { title: ' Safe title ', body: 'Plain\ntext <script>alert(1)</script>' };
  assert.equal(parse(noticeInput, fields).title, 'Safe title');
  assert.equal(parse(noticeInput, fields).body, fields.body);
  for (const extra of [
    { societyId: '2' },
    { authorMembershipId: '2' },
    { publishedAt: '2026-10-01' },
    { title: '\u0000' },
    { body: 'a'.repeat(8001) },
  ])
    assert.throws(() => parse(noticeInput, { ...fields, ...extra }));
  assert.throws(() => parse(noticeEdit, { ...fields, revision: 0 }));
  assert.throws(() => parse(complaintAction, { revision: 1, status: 'OPEN', note: 'Test' }));
  assert.throws(() =>
    parse(complaintAction, {
      revision: 1,
      status: 'ASSIGNED',
      note: 'Test',
      assigneeMembershipId: '0',
    }),
  );
  assert.throws(() => parse(complaintQuery, { pageSize: 51 }));
  assert.throws(() =>
    parse(complaintInput, { flatId: '1', title: 'Test', description: 'Test', category: 'INVALID' }),
  );
});
