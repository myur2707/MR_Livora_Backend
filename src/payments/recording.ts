import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { Session, RequestAudit } from '../auth/types.js';
import type { TenantScope } from '../property/access.js';
import type { BillingAccess } from '../billing/access.js';
import { balanceColumns, balance, type BalanceRow } from '../billing/balances.js';
import { insert, rows, notFound } from '../onboarding/repository.js';
import { sqlTime } from '../auth/repository.js';
import { ApiError } from '../http/errors.js';
import type { RecordInput } from './contracts.js';
import { canonical, fingerprint, validateTotal, minor } from './money.js';
import { collector, paymentPeople } from './people.js';
import { replay, complete, operationDate } from './repository.js';
export class PaymentWriter {
  async write(
    db: PoolConnection,
    scope: TenantScope,
    input: RecordInput,
    now: number,
  ): Promise<string> {
    operationDate(input.paymentDate, scope.today);
    validateTotal(input.amount, input.allocations);
    const collected = await collector(db, scope, input.collectedByUserId, now);
    const people = await paymentPeople(db, scope, input.flatId, input.payerPersonId);
    for (const a of input.allocations) {
      await rows<RowDataPacket>(db, 'SELECT id FROM bills WHERE society_id=? AND id=? FOR UPDATE', [
        scope.societyId,
        a.billId,
      ]);
      const found = await rows<BalanceRow & { flatId: string }>(
        db,
        `SELECT b.flat_id AS flatId,b.status,p.due_on AS dueOn,${balanceColumns} FROM bills b JOIN billing_periods p ON p.society_id=b.society_id AND p.id=b.billing_period_id WHERE b.society_id=? AND b.id=?`,
        [scope.societyId, a.billId],
      );
      const bill = found[0];
      if (!bill || bill.flatId !== input.flatId || bill.status !== 'ISSUED') throw notFound();
      if (minor(a.amount) > minor(balance(bill, scope.today).outstanding))
        throw new ApiError(
          409,
          'OVERPAYMENT',
          'An allocation exceeds the bill outstanding. Refresh balances.',
        );
    }
    // A normalized non-cash reference identifies one bank/UPI/cheque transaction in this society.
    if (input.method !== 'CASH') {
      const duplicate = await rows<RowDataPacket>(
        db,
        'SELECT p.id FROM payments p WHERE p.society_id=? AND p.method=? AND UPPER(TRIM(p.reference))=UPPER(?) AND NOT EXISTS(SELECT 1 FROM payment_reversals r WHERE r.society_id=p.society_id AND r.payment_id=p.id) LIMIT 1',
        [scope.societyId, input.method, input.reference],
      );
      if (duplicate.length)
        throw new ApiError(
          409,
          'DUPLICATE_REFERENCE',
          'This transaction reference is already recorded.',
        );
    }
    const id = await insert(
      db,
      'INSERT INTO payments(society_id,flat_id,payer_person_id,method,payment_date,amount,reference,collected_by_membership_id,recorded_by_membership_id,notes,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        scope.societyId,
        input.flatId,
        input.payerPersonId,
        input.method,
        input.paymentDate,
        input.amount,
        input.reference || null,
        collected.id,
        scope.membershipId,
        input.notes || null,
        input.idempotencyKey,
        sqlTime(now),
      ],
    );
    for (const a of input.allocations)
      await db.execute(
        'INSERT INTO payment_allocations(society_id,payment_id,bill_id,flat_id,amount) VALUES(?,?,?,?,?)',
        [scope.societyId, id, a.billId, input.flatId, a.amount],
      );
    const receiptId = await insert(
      db,
      'INSERT INTO receipts(society_id,payment_id,receipt_number,issued_at,issued_by_membership_id) VALUES(?,?,?,?,?)',
      [scope.societyId, id, 'R-' + scope.societyId + '-' + id, sqlTime(now), scope.membershipId],
    );
    await db.execute(
      'INSERT INTO payment_details(society_id,payment_id,receipt_id,society_name,currency,building_code,flat_number,payer_name,collector_name,recorder_name) VALUES(?,?,?,?,?,?,?,?,?,?)',
      [
        scope.societyId,
        id,
        receiptId,
        people.societyName,
        people.currency,
        people.buildingCode,
        people.flatNumber,
        people.payerName,
        collected.name,
        people.recorderName,
      ],
    );
    return id;
  }
}
export class PaymentRecording {
  constructor(
    readonly access: BillingAccess,
    readonly writer = new PaymentWriter(),
  ) {}
  async record(session: Session, input: RecordInput, audit: RequestAudit) {
    const normalized = canonical(input),
      hash = fingerprint(normalized);
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session, 'society.finance.record');
      const previous = await replay(db, scope.societyId, input.idempotencyKey, hash, 'RECORD');
      if (previous) return { ...previous, replayed: true };
      const paymentId = await this.writer.write(db, scope, normalized, this.access.clock());
      const result = { paymentId };
      await complete(db, scope.societyId, input.idempotencyKey, hash, 'RECORD', result);
      await this.access.audit(db, scope, 'payment.recorded', 'payment', paymentId, audit, {
        allocationCount: input.allocations.length,
      });
      return { ...result, replayed: false };
    });
  }
}
