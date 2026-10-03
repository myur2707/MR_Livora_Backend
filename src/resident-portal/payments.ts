import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { Session } from '../auth/types.js';
import { rows, notFound, utcTimestamp } from '../onboarding/repository.js';
import { minor, money } from '../billing/money.js';
import type { ResidentAccess } from './access.js';
import { type ResidentScope } from './access.js';
import { page } from './repository.js';
import type { PageQuery } from './contracts.js';
interface PaymentRow extends RowDataPacket {
  amount: string;
  refunded: string;
  reversed: number | string;
}
const fields = `p.id,p.flat_id AS flatId,p.method,p.payment_date AS paymentDate,p.amount,p.reference,p.created_at AS recordedAt,
  r.receipt_number AS receiptNumber,r.issued_at AS issuedAt,COALESCE(d.society_name,s.name) AS societyName,
  COALESCE(d.building_code,building.code) AS buildingCode,COALESCE(d.flat_number,f.flat_number) AS flatNumber,
  COALESCE(d.payer_name,sp.display_name) AS payerName,
  EXISTS(SELECT 1 FROM payment_reversals x WHERE x.society_id=p.society_id AND x.payment_id=p.id) AS reversed,
  COALESCE((SELECT SUM(x.amount) FROM payment_refunds x WHERE x.society_id=p.society_id AND x.payment_id=p.id),0) AS refunded`;
const joins =
  ' FROM payments p JOIN societies s ON s.id=p.society_id JOIN flats f ON f.society_id=p.society_id AND f.id=p.flat_id JOIN buildings building ON building.society_id=f.society_id AND building.id=f.building_id JOIN society_persons sp ON sp.society_id=p.society_id AND sp.person_id=p.payer_person_id LEFT JOIN receipts r ON r.society_id=p.society_id AND r.payment_id=p.id LEFT JOIN payment_details d ON d.society_id=p.society_id AND d.payment_id=p.id';
function view(p: PaymentRow) {
  const reversed = Number(p.reversed) === 1;
  const remaining = reversed ? 0n : minor(p.amount) - minor(p.refunded);
  const { reversed: internal, ...safe } = p;
  void internal;
  return {
    ...safe,
    recordedAt: utcTimestamp(p['recordedAt']),
    issuedAt: utcTimestamp(p['issuedAt']),
    netAmount: money(remaining),
    status: reversed
      ? 'REVERSED'
      : remaining === 0n
        ? 'REFUNDED'
        : minor(p.refunded) > 0n
          ? 'PARTIALLY_REFUNDED'
          : 'RECORDED',
  };
}
export class ResidentPayments {
  constructor(readonly access: ResidentAccess) {}
  async history(db: PoolConnection, scope: ResidentScope, query: PageQuery, receiptsOnly = false) {
    const result = await page<PaymentRow>(
      db,
      'SELECT ' + fields,
      joins +
        ' WHERE p.society_id=? AND p.payer_person_id=?' +
        (receiptsOnly ? ' AND r.id IS NOT NULL' : ''),
      [scope.societyId, scope.personId],
      query,
    );
    return { ...result, items: result.items.map(view) };
  }
  async list(session: Session, query: PageQuery, receiptsOnly = false) {
    return this.access.database.transaction(async (db) =>
      this.history(db, await this.access.tenant(db, session), query, receiptsOnly),
    );
  }
  async receipt(session: Session, id: string) {
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session);
      const found = await rows<PaymentRow>(
        db,
        'SELECT ' +
          fields +
          joins +
          ' WHERE p.society_id=? AND p.payer_person_id=? AND p.id=? AND r.id IS NOT NULL',
        [scope.societyId, scope.personId, id],
      );
      const payment = found[0];
      if (!payment) throw notFound();
      const allocations = await rows(
        db,
        'SELECT b.bill_number AS billNumber,a.amount,COALESCE((SELECT SUM(r.amount) FROM payment_refund_allocations r WHERE r.society_id=a.society_id AND r.allocation_id=a.id),0) AS refunded FROM payment_allocations a JOIN bills b ON b.society_id=a.society_id AND b.id=a.bill_id WHERE a.society_id=? AND a.payment_id=? ORDER BY a.bill_id',
        [scope.societyId, id],
      );
      const refunds = await rows(
        db,
        'SELECT amount,refund_date AS date,method FROM payment_refunds WHERE society_id=? AND payment_id=? ORDER BY id',
        [scope.societyId, id],
      );
      return { ...view(payment), allocations, refunds };
    });
  }
}
