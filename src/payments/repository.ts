import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { rows, insert, notFound } from '../onboarding/repository.js';
import { ApiError } from '../http/errors.js';
export interface PaymentRow extends RowDataPacket {
  id: string;
  flatId: string;
  amount: string;
  paymentDate: string;
  reversed: number | string;
  refunded: string;
}
export interface Command {
  paymentId: string;
  refundId?: string;
  reversalId?: string;
  replacementPaymentId?: string;
}
export async function payment(
  db: PoolConnection,
  societyId: string,
  id: string,
): Promise<PaymentRow> {
  // BillingAccess already holds the society write lock. Immutable tables need no UPDATE grant.
  const found = await rows<PaymentRow>(
    db,
    `SELECT p.id,p.flat_id AS flatId,p.amount,p.payment_date AS paymentDate,
    EXISTS(SELECT 1 FROM payment_reversals r WHERE r.society_id=p.society_id AND r.payment_id=p.id) AS reversed,
    COALESCE((SELECT SUM(r.amount) FROM payment_refunds r WHERE r.society_id=p.society_id AND r.payment_id=p.id),0) AS refunded
    FROM payments p WHERE p.society_id=? AND p.id=?`,
    [societyId, id],
  );
  if (!found[0]) throw notFound();
  return { ...found[0], reversed: Number(found[0].reversed) };
}
export async function replay(
  db: PoolConnection,
  societyId: string,
  key: string,
  hash: Buffer,
  kind: string,
): Promise<Command | null> {
  const result = await rows<
    RowDataPacket & {
      request_hash: Buffer;
      kind: string;
      paymentId: string;
      refundId: string | null;
      reversalId: string | null;
      replacementPaymentId: string | null;
    }
  >(
    db,
    'SELECT request_hash,kind,payment_id AS paymentId,refund_id AS refundId,reversal_id AS reversalId,replacement_payment_id AS replacementPaymentId FROM payment_commands WHERE society_id=? AND idempotency_key=?',
    [societyId, key],
  );
  const row = result[0];
  if (!row) return null;
  if (!row.request_hash.equals(hash) || row.kind !== kind)
    throw new ApiError(
      409,
      'IDEMPOTENCY_CONFLICT',
      'This request key was used for a different request.',
    );
  return {
    paymentId: row.paymentId,
    ...(row.refundId ? { refundId: row.refundId } : {}),
    ...(row.reversalId ? { reversalId: row.reversalId } : {}),
    ...(row.replacementPaymentId ? { replacementPaymentId: row.replacementPaymentId } : {}),
  };
}
export async function complete(
  db: PoolConnection,
  societyId: string,
  key: string,
  hash: Buffer,
  kind: string,
  command: Command,
): Promise<void> {
  await insert(
    db,
    'INSERT INTO payment_commands(society_id,idempotency_key,request_hash,kind,payment_id,refund_id,reversal_id,replacement_payment_id) VALUES(?,?,?,?,?,?,?,?)',
    [
      societyId,
      key,
      hash,
      kind,
      command.paymentId,
      command.refundId ?? null,
      command.reversalId ?? null,
      command.replacementPaymentId ?? null,
    ],
  );
}
export function operationDate(date: string, today: string, earliest = '2000-01-01'): void {
  if (date > today || date < earliest)
    throw new ApiError(
      422,
      'PAYMENT_DATE',
      'Use a date no earlier than the payment and no later than today.',
    );
}
