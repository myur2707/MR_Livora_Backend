import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { parse, recordInput, refundInput, listQuery } from '../src/payments/contracts.js';
import { validateTotal, canonical, fingerprint } from '../src/payments/money.js';
import { operationDate } from '../src/payments/repository.js';
void test('allocations reconcile exact cents and reject overflow or unmatched totals', () => {
  validateTotal('0.30', [
    { billId: '1', amount: '0.10' },
    { billId: '2', amount: '0.20' },
  ]);
  validateTotal('9999999999.99', [{ billId: '1', amount: '9999999999.99' }]);
  assert.throws(() => validateTotal('0.31', [{ billId: '1', amount: '0.30' }]));
  assert.throws(() =>
    validateTotal('9999999999.99', [
      { billId: '1', amount: '9999999999.99' },
      { billId: '2', amount: '0.01' },
    ]),
  );
  const a = canonical({
    amount: '3',
    allocations: [
      { billId: '20', amount: '1' },
      { billId: '9', amount: '2' },
    ],
  });
  const b = canonical({
    amount: '3.00',
    allocations: [
      { billId: '9', amount: '2.00' },
      { billId: '20', amount: '1.00' },
    ],
  });
  assert.ok(fingerprint(a).equals(fingerprint(b)));
});
void test('payment boundary validates money, calendar dates, methods and protected fields', () => {
  const input = {
    flatId: '1',
    payerPersonId: '2',
    collectedByUserId: '3',
    method: 'CASH',
    paymentDate: '2026-10-03',
    amount: '10.50',
    allocations: [{ billId: '4', amount: '10.50' }],
    idempotencyKey: randomUUID(),
  };
  assert.equal(parse(recordInput, input).notes, '');
  for (const extra of [
    { amount: '0.00' },
    { amount: '1.001' },
    { amount: '1e3' },
    { method: 'OTHER' },
    { method: 'UPI' },
    { paymentDate: '2026-02-30' },
    { recordedByUserId: '8' },
    { societyId: '9' },
    {
      allocations: [
        { billId: '4', amount: '5' },
        { billId: '4', amount: '5.50' },
      ],
    },
  ])
    assert.throws(() => parse(recordInput, { ...input, ...extra }));
  assert.throws(() =>
    parse(refundInput, {
      reason: 'Refund approved',
      operationDate: '2026-10-03',
      idempotencyKey: randomUUID(),
      amount: '1',
      allocations: [{ billId: '4', amount: '1' }],
      method: 'CHEQUE',
      reference: '',
    }),
  );
  assert.throws(() => parse(listQuery, { from: '2026-10-04', to: '2026-10-03' }));
  assert.throws(() => parse(listQuery, { societyId: '9' }));
  assert.throws(() => operationDate('2026-10-04', '2026-10-03'));
  assert.throws(() => operationDate('2026-10-01', '2026-10-03', '2026-10-02'));
});
