import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { Session } from '../auth/types.js';
import { rows, notFound, utcTimestamp } from '../onboarding/repository.js';
import { balanceColumns, balance, type BalanceRow } from '../billing/balances.js';
import type { ResidentAccess } from './access.js';
import { flatPolicy, type ResidentScope } from './access.js';
import type { BillQuery } from './contracts.js';
import { page, type Values } from './repository.js';
const fields = `b.id,b.bill_number AS billNumber,b.flat_id AS flatId,b.status,b.issued_at AS issuedAt,
  COALESCE(d.building_code,building.code) AS buildingCode,COALESCE(d.flat_number,f.flat_number) AS flatNumber,
  COALESCE(d.period_code,p.code) AS periodCode,p.due_on AS dueOn,p.starts_on AS startsOn,p.ends_on AS endsOn,${balanceColumns}`;
const joins =
  ' FROM bills b JOIN billing_periods p ON p.society_id=b.society_id AND p.id=b.billing_period_id JOIN flats f ON f.society_id=b.society_id AND f.id=b.flat_id JOIN buildings building ON building.society_id=f.society_id AND building.id=f.building_id LEFT JOIN billing_bill_details d ON d.society_id=b.society_id AND d.bill_id=b.id';
function source(scope: ResidentScope, query: BillQuery) {
  const policy = flatPolicy(scope, true);
  const values: Values = [scope.societyId, ...policy.values];
  let sql = joins + " WHERE b.society_id=? AND b.status='ISSUED' AND " + policy.sql;
  if (query.flatId) {
    sql += ' AND b.flat_id=?';
    values.push(query.flatId);
  }
  return { sql, values };
}
function report(scope: ResidentScope, query: BillQuery) {
  const base = source(scope, query);
  const sql =
    ' FROM (SELECT ' +
    fields +
    base.sql +
    ') report' +
    (query.status === 'OUTSTANDING'
      ? ' WHERE gross-credits-paid>0'
      : query.status === 'SETTLED'
        ? ' WHERE gross-credits-paid<=0'
        : '');
  return { sql, values: base.values };
}
export class ResidentBills {
  constructor(readonly access: ResidentAccess) {}
  async list(session: Session, query: BillQuery) {
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session);
      if (query.flatId) await this.access.flat(db, scope, query.flatId);
      const base = report(scope, query);
      const result = await page<BalanceRow>(db, 'SELECT *', base.sql, base.values, query);
      return {
        ...result,
        items: result.items.map((row) => ({
          ...row,
          issuedAt: utcTimestamp(row['issuedAt']),
          ...balance(row, scope.today),
        })),
      };
    });
  }
  async detail(session: Session, id: string) {
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session),
        base = source(scope, { page: 1, pageSize: 20, status: 'ALL' });
      const result = await rows<BalanceRow>(db, 'SELECT ' + fields + base.sql + ' AND b.id=?', [
        ...base.values,
        id,
      ]);
      const bill = result[0];
      if (!bill) throw notFound();
      const items = await rows(
        db,
        'SELECT line_number AS lineNumber,description,quantity,unit_rate AS unitRate,amount FROM bill_items WHERE society_id=? AND bill_id=? ORDER BY line_number',
        [scope.societyId, id],
      );
      // Discount reasons/audit actor names can contain private committee information.
      return {
        ...bill,
        issuedAt: utcTimestamp(bill['issuedAt']),
        ...balance(bill, scope.today),
        items,
      };
    });
  }
  async summary(db: PoolConnection, scope: ResidentScope) {
    const base = report(scope, { page: 1, pageSize: 20, status: 'OUTSTANDING' });
    const found = await rows<RowDataPacket & { currentDue: string; overdue: string }>(
      db,
      'SELECT COALESCE(SUM(IF(dueOn>=?,gross-credits-paid,0)),0) AS currentDue,COALESCE(SUM(IF(dueOn<?,gross-credits-paid,0)),0) AS overdue' +
        base.sql,
      [scope.today, scope.today, ...base.values],
    );
    return found[0] ?? { currentDue: '0.00', overdue: '0.00' };
  }
}
