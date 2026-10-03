import type { RowDataPacket } from 'mysql2/promise';
import type { Session } from '../auth/types.js';
import { rows, notFound, utcTimestamp } from '../onboarding/repository.js';
import type { BillingAccess } from './access.js';
import { balanceColumns, balance, type BalanceRow } from './balances.js';
import type { ListQuery } from './contracts.js';
const details = `b.id,b.bill_number AS billNumber,b.billing_period_id AS periodId,b.flat_id AS flatId,b.status,b.issued_at AS issuedAt,
  COALESCE(d.building_code,building.code) AS buildingCode,COALESCE(d.flat_number,f.flat_number) AS flatNumber,
  COALESCE(d.period_code,p.code) AS periodCode,COALESCE(d.starts_on,p.starts_on) AS startsOn,COALESCE(d.ends_on,p.ends_on) AS endsOn,COALESCE(d.due_on,p.due_on) AS dueOn,d.previous_outstanding AS previousOutstanding,${balanceColumns}`;
const joins = ` FROM bills b JOIN flats f ON f.society_id=b.society_id AND f.id=b.flat_id JOIN buildings building ON building.society_id=f.society_id AND building.id=f.building_id JOIN billing_periods p ON p.society_id=b.society_id AND p.id=b.billing_period_id LEFT JOIN billing_bill_details d ON d.society_id=b.society_id AND d.bill_id=b.id`;
export class BillingQueries {
  constructor(readonly access: BillingAccess) {}
  async list(session: Session, query: ListQuery, outstandingOnly = false) {
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session);
      const where =
        ' WHERE b.society_id=?' +
        (outstandingOnly ? " AND b.status='ISSUED'" : '') +
        (query.periodId ? ' AND b.billing_period_id=?' : '') +
        (query.buildingId ? ' AND f.building_id=?' : '') +
        (query.flatId ? ' AND b.flat_id=?' : '') +
        " AND b.bill_number LIKE ? ESCAPE '='";
      const values: (string | number)[] = [scope.societyId];
      if (query.periodId) values.push(query.periodId);
      if (query.buildingId) values.push(query.buildingId);
      if (query.flatId) values.push(query.flatId);
      values.push('%' + query.q.replace(/[=%_]/g, '=$&') + '%');
      const source = '(SELECT ' + details + joins + where + ') report';
      const remaining = '(gross-credits-paid)';
      const status =
        outstandingOnly || query.status === 'OUTSTANDING'
          ? " WHERE status='ISSUED' AND " + remaining + '>0'
          : query.status === 'SETTLED'
            ? " WHERE status='ISSUED' AND " + remaining + '<=0'
            : query.status === 'ISSUED'
              ? " WHERE status='ISSUED'"
              : '';
      const summary = await rows<
        RowDataPacket & { total: number; outstanding: string; creditBalance: string }
      >(
        db,
        "SELECT COUNT(*) AS total,COALESCE(SUM(IF(status='ISSUED',GREATEST(" +
          remaining +
          ",0),0)),0) AS outstanding,COALESCE(SUM(IF(status='ISSUED',GREATEST(-" +
          remaining +
          ',0),0)),0) AS creditBalance FROM ' +
          source +
          status,
        values,
      );
      const result = await rows<BalanceRow>(
        db,
        'SELECT * FROM ' + source + status + ' ORDER BY id DESC LIMIT ? OFFSET ?',
        [...values, query.pageSize, (query.page - 1) * query.pageSize],
      );
      return {
        items: result.map((row) => ({
          ...row,
          issuedAt: utcTimestamp(row['issuedAt']),
          ...balance(row, scope.today),
        })),
        total: Number(summary[0]?.total ?? 0),
        page: query.page,
        pageSize: query.pageSize,
        summary: {
          outstanding: summary[0]?.outstanding ?? '0.00',
          creditBalance: summary[0]?.creditBalance ?? '0.00',
        },
      };
    });
  }
  async detail(session: Session, id: string) {
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session);
      const result = await rows<BalanceRow>(
        db,
        'SELECT ' + details + joins + ' WHERE b.society_id=? AND b.id=?',
        [scope.societyId, id],
      );
      const bill = result[0];
      if (!bill) throw notFound();
      const items = await rows<RowDataPacket>(
        db,
        'SELECT id,line_number AS lineNumber,description,quantity,unit_rate AS unitRate,amount,charge_configuration_id AS configurationId FROM bill_items WHERE society_id=? AND bill_id=? ORDER BY line_number',
        [scope.societyId, id],
      );
      const adjustments = await rows<RowDataPacket>(
        db,
        'SELECT a.id,a.direction,a.amount,a.reason,d.kind,d.value FROM bill_adjustments a LEFT JOIN billing_discount_details d ON d.society_id=a.society_id AND d.adjustment_id=a.id WHERE a.society_id=? AND a.bill_id=? ORDER BY a.id',
        [scope.societyId, id],
      );
      return {
        ...bill,
        issuedAt: utcTimestamp(bill['issuedAt']),
        ...balance(bill, scope.today),
        items,
        adjustments,
      };
    });
  }
}
