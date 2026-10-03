import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { Session, RequestAudit } from '../auth/types.js';
import type { TenantScope } from '../property/access.js';
import type { BillingAccess } from '../billing/access.js';
import { insert, rows } from '../onboarding/repository.js';
import { sqlTime } from '../auth/repository.js';
import { ApiError } from '../http/errors.js';
import type { ReverseInput, RefundInput, CorrectionInput } from './contracts.js';
import { canonical, fingerprint, validateTotal, minor } from './money.js';
import { replay, complete, payment, operationDate } from './repository.js';
import { PaymentWriter } from './recording.js';
async function reverse(
  db: PoolConnection,
  scope: TenantScope,
  id: string,
  input: ReverseInput,
  now: number,
): Promise<string> {
  const original = await payment(db, scope.societyId, id);
  operationDate(input.operationDate, scope.today, original.paymentDate);
  if (original.reversed || minor(original.refunded) > 0n)
    throw new ApiError(
      409,
      'PAYMENT_STATE',
      'A reversed or refunded payment cannot be reversed or corrected.',
    );
  const reversalId = await insert(
    db,
    'INSERT INTO payment_reversals(society_id,payment_id,reason,reversed_by_membership_id,idempotency_key,created_at) VALUES(?,?,?,?,?,?)',
    [scope.societyId, id, input.reason, scope.membershipId, input.idempotencyKey, sqlTime(now)],
  );
  await db.execute(
    'INSERT INTO payment_reversal_details(society_id,reversal_id,operation_date) VALUES(?,?,?)',
    [scope.societyId, reversalId, input.operationDate],
  );
  return reversalId;
}
export class PaymentLifecycle {
  constructor(
    readonly access: BillingAccess,
    readonly writer = new PaymentWriter(),
  ) {}
  async reverse(session: Session, id: string, input: ReverseInput, audit: RequestAudit) {
    const hash = fingerprint({ id, ...input });
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session, 'society.finance.reverse');
      const previous = await replay(db, scope.societyId, input.idempotencyKey, hash, 'REVERSE');
      if (previous) return { ...previous, replayed: true };
      const result = {
        paymentId: id,
        reversalId: await reverse(db, scope, id, input, this.access.clock()),
      };
      await complete(db, scope.societyId, input.idempotencyKey, hash, 'REVERSE', result);
      await this.access.audit(db, scope, 'payment.reversed', 'payment', id, audit);
      return { ...result, replayed: false };
    });
  }
  async refund(session: Session, id: string, input: RefundInput, audit: RequestAudit) {
    const normalized = canonical(input),
      hash = fingerprint({ id, ...normalized });
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session, 'society.finance.reverse');
      const previous = await replay(db, scope.societyId, input.idempotencyKey, hash, 'REFUND');
      if (previous) return { ...previous, replayed: true };
      validateTotal(normalized.amount, normalized.allocations);
      const original = await payment(db, scope.societyId, id);
      operationDate(input.operationDate, scope.today, original.paymentDate);
      if (
        original.reversed ||
        minor(input.amount) > minor(original.amount) - minor(original.refunded)
      )
        throw new ApiError(409, 'PAYMENT_STATE', 'Refund exceeds the remaining recorded payment.');
      const allocations = await rows<
        RowDataPacket & { id: string; billId: string; amount: string; refunded: string }
      >(
        db,
        'SELECT a.id,a.bill_id AS billId,a.amount,COALESCE((SELECT SUM(r.amount) FROM payment_refund_allocations r WHERE r.society_id=a.society_id AND r.allocation_id=a.id),0) AS refunded FROM payment_allocations a WHERE a.society_id=? AND a.payment_id=?',
        [scope.societyId, id],
      );
      const selected = normalized.allocations.map((a) => {
        const original = allocations.find((o) => o.billId === a.billId);
        if (!original || minor(a.amount) > minor(original.amount) - minor(original.refunded))
          throw new ApiError(
            409,
            'REFUND_ALLOCATION',
            'A refund exceeds the remaining original allocation.',
          );
        return { ...a, allocationId: original.id };
      });
      const refundId = await insert(
        db,
        'INSERT INTO payment_refunds(society_id,payment_id,amount,refund_date,method,reference,reason,recorded_by_membership_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        [
          scope.societyId,
          id,
          normalized.amount,
          input.operationDate,
          input.method,
          input.reference || null,
          input.reason,
          scope.membershipId,
          sqlTime(this.access.clock()),
        ],
      );
      for (const a of selected)
        await db.execute(
          'INSERT INTO payment_refund_allocations(society_id,refund_id,payment_id,allocation_id,bill_id,flat_id,amount) VALUES(?,?,?,?,?,?,?)',
          [scope.societyId, refundId, id, a.allocationId, a.billId, original.flatId, a.amount],
        );
      const result = { paymentId: id, refundId };
      await complete(db, scope.societyId, input.idempotencyKey, hash, 'REFUND', result);
      await this.access.audit(db, scope, 'payment.refunded', 'payment', id, audit, { refundId });
      return { ...result, replayed: false };
    });
  }
  async correct(session: Session, id: string, input: CorrectionInput, audit: RequestAudit) {
    const replacement = canonical({
      ...input.replacement,
      idempotencyKey: fingerprint({ key: input.idempotencyKey, action: 'replacement' }).toString(
        'hex',
      ),
    });
    const hash = fingerprint({ id, ...input, replacement });
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session, 'society.finance.reverse');
      await this.access.tenant(db, session, 'society.finance.record');
      const previous = await replay(db, scope.societyId, input.idempotencyKey, hash, 'CORRECT');
      if (previous) return { ...previous, replayed: true };
      const original = await payment(db, scope.societyId, id);
      if (replacement.flatId !== original.flatId)
        throw new ApiError(422, 'PAYMENT_STATE', 'Corrections must retain the original flat.');
      const reversalId = await reverse(db, scope, id, input, this.access.clock());
      const replacementPaymentId = await this.writer.write(
        db,
        scope,
        replacement,
        this.access.clock(),
      );
      const result = { paymentId: id, reversalId, replacementPaymentId };
      await complete(db, scope.societyId, input.idempotencyKey, hash, 'CORRECT', result);
      await this.access.audit(db, scope, 'payment.corrected', 'payment', id, audit, {
        replacementPaymentId,
      });
      return { ...result, replayed: false };
    });
  }
}
