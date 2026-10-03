import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { Session } from '../auth/types.js';
import type { BillingAccess } from '../billing/access.js';
import { rows, notFound, utcTimestamp } from '../onboarding/repository.js';
import { sqlTime } from '../auth/repository.js';
import { minor, money } from './money.js';
import { collectorSource } from './people.js';
import type { ListQuery } from './contracts.js';
import { collectionLedger } from './ledger.js';
const projection = `p.id,p.flat_id AS flatId,p.payer_person_id AS payerPersonId,p.method,p.payment_date AS paymentDate,p.amount,p.reference,p.notes,p.created_at AS recordedAt,
 cm.user_id AS collectedByUserId,rm.user_id AS recordedByUserId,r.receipt_number AS receiptNumber,r.issued_at AS issuedAt,
 COALESCE(d.society_name,s.name) AS societyName,COALESCE(d.currency,'INR') AS currency,
 COALESCE(d.building_code,b.code) AS buildingCode,COALESCE(d.flat_number,f.flat_number) AS flatNumber,
 COALESCE(d.payer_name,sp.display_name) AS payerName,d.collector_name AS collectorName,d.recorder_name AS recorderName,
 IF(d.id IS NULL,1,0) AS legacyReceipt,
 EXISTS(SELECT 1 FROM payment_reversals x WHERE x.society_id=p.society_id AND x.payment_id=p.id) AS reversed,
 COALESCE((SELECT SUM(x.amount) FROM payment_refunds x WHERE x.society_id=p.society_id AND x.payment_id=p.id),0) AS refunded`;
const source = ` FROM payments p JOIN societies s ON s.id=p.society_id JOIN flats f ON f.society_id=p.society_id AND f.id=p.flat_id JOIN buildings b ON b.society_id=f.society_id AND b.id=f.building_id
 JOIN society_persons sp ON sp.society_id=p.society_id AND sp.person_id=p.payer_person_id
 JOIN society_memberships rm ON rm.society_id=p.society_id AND rm.id=p.recorded_by_membership_id
 LEFT JOIN society_memberships cm ON cm.society_id=p.society_id AND cm.id=p.collected_by_membership_id
 LEFT JOIN receipts r ON r.society_id=p.society_id AND r.payment_id=p.id LEFT JOIN payment_details d ON d.society_id=p.society_id AND d.payment_id=p.id`;
interface PaymentView extends RowDataPacket {
  receiptNumber: string | null;
  amount: string;
  refunded: string;
  reversed: number | string;
  recordedAt: string;
  issuedAt: string | null;
}
function view(p: PaymentView) {
  const reversed = Number(p.reversed) === 1;
  const net = reversed ? 0n : minor(p.amount) - minor(p.refunded);
  return {
    ...p,
    recordedAt: utcTimestamp(p.recordedAt),
    issuedAt: utcTimestamp(p.issuedAt),
    netAmount: money(net),
    reversed: Number(p.reversed),
    legacyReceipt: Number(p['legacyReceipt']),
    status: reversed
      ? 'REVERSED'
      : net === 0n
        ? 'REFUNDED'
        : minor(p.refunded) > 0n
          ? 'PARTIALLY_REFUNDED'
          : 'RECORDED',
  };
}
function filters(query: ListQuery) {
  const values: (string | number)[] = [],
    terms: string[] = [];
  for (const [column, value, op] of [
    ['flatId', query.flatId, '='],
    ['eventDate', query.from, '>='],
    ['eventDate', query.to, '<='],
    ['collectedByUserId', query.collectorUserId, '='],
    ['method', query.method, '='],
  ] as const)
    if (value) {
      terms.push(column + op + '?');
      values.push(value);
    }
  if (query.q) {
    terms.push(
      "(COALESCE(receiptNumber,'') LIKE ? ESCAPE '=' OR COALESCE(reference,'') LIKE ? ESCAPE '=')",
    );
    const q = '%' + query.q.replace(/[=%_]/g, '=$&') + '%';
    values.push(q, q);
  }
  return { where: terms.length ? ' WHERE ' + terms.join(' AND ') : '', values };
}
async function page<T extends RowDataPacket>(
  db: PoolConnection,
  sql: string,
  values: (string | number)[],
  query: ListQuery,
  events = false,
) {
  const count = await rows<RowDataPacket & { total: number }>(
    db,
    'SELECT COUNT(*) AS total FROM (' + sql + ') counted',
    values,
  );
  const items = await rows<T>(
    db,
    sql + ' ORDER BY eventDate DESC,id DESC' + (events ? ',kind DESC' : '') + ' LIMIT ? OFFSET ?',
    [...values, query.pageSize, (query.page - 1) * query.pageSize],
  );
  return { items, total: Number(count[0]?.total ?? 0), page: query.page, pageSize: query.pageSize };
}
export class PaymentQueries {
  constructor(readonly access: BillingAccess) {}
  async list(session: Session, query: ListQuery) {
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session),
        filter = filters(query);
      const sql =
        'SELECT * FROM (SELECT ' +
        projection +
        ',p.payment_date AS eventDate' +
        source +
        ' WHERE p.society_id=?) payments' +
        filter.where;
      const result = await page<PaymentView>(db, sql, [scope.societyId, ...filter.values], query);
      return { ...result, items: result.items.map(view) };
    });
  }
  async detail(session: Session, id: string, receiptOnly = false) {
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session);
      const found = await rows<PaymentView>(
        db,
        'SELECT ' + projection + source + ' WHERE p.society_id=? AND p.id=?',
        [scope.societyId, id],
      );
      const p = found[0];
      if (!p || (receiptOnly && !p['receiptNumber'])) throw notFound();
      const allocations = await rows<RowDataPacket>(
        db,
        `SELECT a.bill_id AS billId,b.bill_number AS billNumber,a.amount,
        COALESCE((SELECT SUM(r.amount) FROM payment_refund_allocations r WHERE r.society_id=a.society_id AND r.allocation_id=a.id),0) AS refunded
        FROM payment_allocations a JOIN bills b ON b.society_id=a.society_id AND b.id=a.bill_id WHERE a.society_id=? AND a.payment_id=? ORDER BY a.bill_id`,
        [scope.societyId, id],
      );
      const refunds = await rows<RowDataPacket>(
        db,
        'SELECT r.id,r.amount,r.refund_date AS operationDate,r.method,r.reference,r.reason,m.user_id AS recordedByUserId,r.created_at AS recordedAt FROM payment_refunds r JOIN society_memberships m ON m.society_id=r.society_id AND m.id=r.recorded_by_membership_id WHERE r.society_id=? AND r.payment_id=? ORDER BY r.id',
        [scope.societyId, id],
      );
      const reversals = await rows<RowDataPacket>(
        db,
        'SELECT r.id,r.reason,COALESCE(d.operation_date,DATE(r.created_at)) AS operationDate,m.user_id AS recordedByUserId,c.replacement_payment_id AS replacementPaymentId FROM payment_reversals r LEFT JOIN payment_reversal_details d ON d.society_id=r.society_id AND d.reversal_id=r.id JOIN society_memberships m ON m.society_id=r.society_id AND m.id=r.reversed_by_membership_id LEFT JOIN payment_commands c ON c.society_id=r.society_id AND c.reversal_id=r.id WHERE r.society_id=? AND r.payment_id=?',
        [scope.societyId, id],
      );
      const correctedFrom = await rows<RowDataPacket & { paymentId: string }>(
        db,
        'SELECT payment_id AS paymentId FROM payment_commands WHERE society_id=? AND replacement_payment_id=?',
        [scope.societyId, id],
      );
      return {
        ...view(p),
        allocations,
        refunds: refunds.map((r) => ({ ...r, recordedAt: utcTimestamp(r['recordedAt']) })),
        reversal: reversals[0] ?? null,
        correctedFromPaymentId: correctedFrom[0]?.paymentId ?? null,
      };
    });
  }
  async choices(
    session: Session,
    resource: 'collectors' | 'payers' | 'report-collectors',
    query: ListQuery,
  ) {
    if (resource === 'report-collectors') return this.historicalCollectors(session, query);
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session);
      const q = '%' + query.q.replace(/[=%_]/g, '=$&') + '%';
      const source =
        resource === 'collectors'
          ? collectorSource + " AND sp.display_name LIKE ? ESCAPE '='"
          : " FROM society_persons sp WHERE sp.society_id=? AND sp.archived_at IS NULL AND sp.display_name LIKE ? ESCAPE '='";
      const values =
        resource === 'collectors'
          ? [scope.societyId, sqlTime(this.access.clock()), q]
          : [scope.societyId, q];
      const count = await rows<RowDataPacket & { total: number }>(
        db,
        'SELECT COUNT(*) AS total' + source,
        values,
      );
      const items = await rows<RowDataPacket>(
        db,
        'SELECT ' +
          (resource === 'collectors' ? 'm.user_id' : 'sp.person_id') +
          ' AS id,sp.display_name AS name' +
          source +
          ' ORDER BY id LIMIT ? OFFSET ?',
        [...values, query.pageSize, (query.page - 1) * query.pageSize],
      );
      return {
        items,
        total: Number(count[0]?.total ?? 0),
        page: query.page,
        pageSize: query.pageSize,
      };
    });
  }
  private async historicalCollectors(session: Session, query: ListQuery) {
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session);
      const source = ` FROM society_memberships m JOIN users u ON u.id=m.user_id
        LEFT JOIN membership_person_links l ON l.society_id=m.society_id AND l.membership_id=m.id
        JOIN society_persons sp ON sp.society_id=m.society_id AND sp.person_id=COALESCE(l.person_id,u.person_id)
        WHERE m.society_id=? AND EXISTS(SELECT 1 FROM payments p WHERE p.society_id=m.society_id AND p.collected_by_membership_id=m.id)`;
      const name = `COALESCE((SELECT d.collector_name FROM payment_details d JOIN payments p ON p.society_id=d.society_id AND p.id=d.payment_id WHERE p.society_id=m.society_id AND p.collected_by_membership_id=m.id ORDER BY p.id DESC LIMIT 1),sp.display_name)`;
      const sql =
        ' FROM (SELECT m.user_id AS id,' +
        name +
        ' AS name' +
        source +
        ") choices WHERE name LIKE ? ESCAPE '='";
      const values = [scope.societyId, '%' + query.q.replace(/[=%_]/g, '=$&') + '%'];
      const count = await rows<RowDataPacket & { total: string | number }>(
        db,
        'SELECT COUNT(*) AS total' + sql,
        values,
      );
      const items = await rows<RowDataPacket>(
        db,
        'SELECT id,name' + sql + ' ORDER BY id LIMIT ? OFFSET ?',
        [...values, query.pageSize, (query.page - 1) * query.pageSize],
      );
      return {
        items,
        total: Number(count[0]?.total ?? 0),
        page: query.page,
        pageSize: query.pageSize,
      };
    });
  }
  async report(session: Session, query: ListQuery) {
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session),
        filter = filters(query);
      const ledger = collectionLedger;
      const sql = 'SELECT * FROM (' + ledger + ') ledger' + filter.where,
        values = [scope.societyId, scope.societyId, scope.societyId, ...filter.values];
      const summary = await rows<RowDataPacket>(
        db,
        "SELECT COALESCE(SUM(IF(kind='COLLECTION',amount,0)),0) AS collections,COALESCE(SUM(IF(kind='REFUND',-amount,0)),0) AS refunds,COALESCE(SUM(IF(kind='REVERSAL',-amount,0)),0) AS reversals,COALESCE(SUM(amount),0) AS netRecorded FROM (" +
          sql +
          ') totals',
        values,
      );
      return { ...(await page<RowDataPacket>(db, sql, values, query, true)), summary: summary[0] };
    });
  }
}
