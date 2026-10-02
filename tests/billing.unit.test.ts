import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { minor, money, lineAmount, discountAmount } from '../src/billing/money.js';
import {
  parse,
  periodInput,
  configurationInput,
  previewInput,
  generationInput,
} from '../src/billing/contracts.js';
void test('exact money preserves decimal limits, positive half-up ties and bounded sums', () => {
  assert.equal(minor('9999999999.99'), 999999999999n);
  assert.equal(money(minor('12.5')), '12.50');
  assert.equal(money(lineAmount('12.50', '0.05')), '0.63');
  assert.equal(money(lineAmount('0.10', '0.05')), '0.01');
  assert.equal(money(discountAmount(30063n, 'PERCENT', '33.33')), '100.20');
  assert.equal(discountAmount(1n, 'PERCENT', '50'), 1n);
  for (const value of ['-1', '1e2', '1.001', 'NaN', '10000000000.00'])
    assert.throws(() => minor(value));
  assert.throws(() => lineAmount('99999999.99', '9999999999.99'));
  assert.throws(() => discountAmount(100n, 'FIXED', '1.01'));
  assert.throws(() => discountAmount(100n, 'PERCENT', '100.01'));
  assert.throws(() => discountAmount(100n, 'FIXED', '0'));
});
void test('calendar periods, scope fields, mass assignment and batch identifiers are validated', () => {
  const period = {
    code: 'NOV',
    kind: 'MONTHLY',
    startsOn: '2026-11-01',
    endsOn: '2026-11-30',
    dueOn: '2026-11-10',
  };
  assert.equal(parse(periodInput, period).kind, 'MONTHLY');
  for (const extra of [
    { startsOn: '2026-11-02' },
    { startsOn: '2026-99-99' },
    { endsOn: '2026-11-31' },
    { dueOn: '2026-10-31' },
    { societyId: '1' },
  ])
    assert.throws(() => parse(periodInput, { ...period, ...extra }));
  assert.throws(() => parse(previewInput, { periodId: '1', flatIds: ['1', '1'] }));
  assert.throws(() =>
    parse(generationInput, {
      periodId: '1',
      flatIds: ['1'],
      discounts: [{ flatId: '2', kind: 'FIXED', value: '1', reason: 'Checked' }],
      previewHash: 'a'.repeat(64),
      idempotencyKey: randomUUID(),
    }),
  );
  assert.throws(() =>
    parse(configurationInput, {
      chargeTypeId: '1',
      scope: 'SOCIETY',
      flatId: '1',
      calculationMethod: 'FLAT_RATE',
      rate: '1.00',
      effectiveFrom: '2026-01-01',
      effectiveUntil: null,
      eligibility: 'ALL_FLATS',
      enabled: true,
    }),
  );
});
