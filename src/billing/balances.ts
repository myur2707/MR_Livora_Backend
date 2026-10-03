import type { RowDataPacket } from 'mysql2/promise';
import { minor, money } from './money.js';
// All subqueries correlate BOTH society and bill. Exact SQL DECIMAL results stay strings.
export const balanceColumns = `b.total_amount AS gross,
  COALESCE((SELECT SUM(IF(a.direction='CREDIT',a.amount,-a.amount)) FROM bill_adjustments a WHERE a.society_id=b.society_id AND a.bill_id=b.id),0) AS credits,
  COALESCE((SELECT SUM(pa.amount-COALESCE((SELECT SUM(ra.amount) FROM payment_refund_allocations ra WHERE ra.society_id=pa.society_id AND ra.allocation_id=pa.id),0)) FROM payment_allocations pa WHERE pa.society_id=b.society_id AND pa.bill_id=b.id AND NOT EXISTS(SELECT 1 FROM payment_reversals pr WHERE pr.society_id=pa.society_id AND pr.payment_id=pa.payment_id)),0) AS paid`;
export interface BalanceRow extends RowDataPacket {
  gross: string;
  credits: string;
  paid: string;
  dueOn: string;
  status: string;
}
function signed(value: string): bigint {
  return value.startsWith('-') ? -minor(value.slice(1)) : minor(value);
}
export function balance(row: BalanceRow, today: string) {
  const net = minor(row.gross) - signed(row.credits);
  const paid = minor(row.paid);
  const remaining = net - paid;
  const outstanding = remaining > 0n ? remaining : 0n;
  const status =
    row.status === 'DRAFT'
      ? 'DRAFT'
      : outstanding === 0n
        ? 'SETTLED'
        : row.dueOn < today
          ? 'OVERDUE'
          : paid > 0n
            ? 'PARTIALLY_PAID'
            : 'UNPAID';
  return {
    gross: row.gross,
    credits: row.credits,
    net: money(net),
    paid: row.paid,
    outstanding: money(outstanding),
    creditBalance: money(remaining < 0n ? -remaining : 0n),
    settlementStatus: status,
  };
}
