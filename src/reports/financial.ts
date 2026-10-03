import { balanceColumns } from '../billing/balances.js';
import { collectionLedger } from '../payments/ledger.js';
import type { TenantScope } from '../property/access.js';
export interface ReportSource {
  sql: string;
  values: (string | number)[];
  dateColumn: string;
  nameColumn?: string;
  moneyColumns: string[];
  searchColumns: string[];
}
export function billSource(scope: TenantScope): ReportSource {
  const base =
    'SELECT b.id,b.flat_id AS flatId,f.building_id AS buildingId,b.billing_period_id AS periodId,b.bill_number AS billNumber,b.status AS billStatus,COALESCE(d.building_code,building.code) AS buildingCode,COALESCE(d.flat_number,f.flat_number) AS flatNumber,COALESCE(d.period_code,p.code) AS periodCode,COALESCE(d.starts_on,p.starts_on) AS startsOn,COALESCE(d.due_on,p.due_on) AS dueOn,' +
    balanceColumns +
    ' FROM bills b JOIN flats f ON f.society_id=b.society_id AND f.id=b.flat_id JOIN buildings building ON building.society_id=f.society_id AND building.id=f.building_id JOIN billing_periods p ON p.society_id=b.society_id AND p.id=b.billing_period_id LEFT JOIN billing_bill_details d ON d.society_id=b.society_id AND d.bill_id=b.id WHERE b.society_id=?';
  const totals =
    'SELECT base.*,gross-credits AS net,GREATEST(gross-credits-paid,0) AS outstanding,GREATEST(paid-gross+credits,0) AS creditBalance FROM (' +
    base +
    ') base';
  const sql =
    "SELECT totals.*,CASE WHEN billStatus='DRAFT' THEN 'DRAFT' WHEN outstanding=0 THEN 'SETTLED' WHEN dueOn<? THEN 'OVERDUE' WHEN paid>0 THEN 'PARTIALLY_PAID' ELSE 'UNPAID' END AS status FROM (" +
    totals +
    ') totals';
  return {
    sql,
    values: [scope.today, scope.societyId],
    dateColumn: 'startsOn',
    moneyColumns: ['gross', 'credits', 'net', 'paid', 'outstanding', 'creditBalance'],
    searchColumns: ['billNumber', 'buildingCode', 'flatNumber', 'periodCode'],
  };
}
export function paymentSource(scope: TenantScope): ReportSource {
  const base =
    'SELECT p.id,p.flat_id AS flatId,f.building_id AS buildingId,p.payment_date AS eventDate,p.method,p.reference,p.amount,COALESCE(d.payer_name,sp.display_name) AS payerName,COALESCE(d.building_code,building.code) AS buildingCode,COALESCE(d.flat_number,f.flat_number) AS flatNumber,r.receipt_number AS receiptNumber,cm.user_id AS collectedByUserId,EXISTS(SELECT 1 FROM payment_reversals x WHERE x.society_id=p.society_id AND x.payment_id=p.id) AS reversed,COALESCE((SELECT SUM(x.amount) FROM payment_refunds x WHERE x.society_id=p.society_id AND x.payment_id=p.id),0) AS refunded FROM payments p JOIN flats f ON f.society_id=p.society_id AND f.id=p.flat_id JOIN buildings building ON building.society_id=f.society_id AND building.id=f.building_id JOIN society_persons sp ON sp.society_id=p.society_id AND sp.person_id=p.payer_person_id LEFT JOIN society_memberships cm ON cm.society_id=p.society_id AND cm.id=p.collected_by_membership_id LEFT JOIN receipts r ON r.society_id=p.society_id AND r.payment_id=p.id LEFT JOIN payment_details d ON d.society_id=p.society_id AND d.payment_id=p.id WHERE p.society_id=?';
  return {
    sql:
      "SELECT base.*,IF(reversed,0,amount-refunded) AS netAmount,IF(reversed,amount,0) AS reversedAmount,CASE WHEN reversed THEN 'REVERSED' WHEN refunded=amount THEN 'REFUNDED' WHEN refunded>0 THEN 'PARTIALLY_REFUNDED' ELSE 'RECORDED' END AS status FROM (" +
      base +
      ') base',
    values: [scope.societyId],
    dateColumn: 'eventDate',
    moneyColumns: ['amount', 'refunded', 'netAmount', 'reversedAmount'],
    searchColumns: ['receiptNumber', 'reference', 'payerName', 'buildingCode', 'flatNumber'],
  };
}
export function collectionSource(scope: TenantScope): ReportSource {
  return {
    sql:
      "SELECT ledger.*,f.building_id AS buildingId,building.code AS buildingCode,f.flat_number AS flatNumber,COALESCE(pd.collector_name,collector_person.display_name,'Unspecified') AS collectorName FROM (" +
      collectionLedger +
      ') ledger JOIN payments original ON original.society_id=? AND original.id=ledger.paymentId JOIN flats f ON f.society_id=original.society_id AND f.id=original.flat_id JOIN buildings building ON building.society_id=f.society_id AND building.id=f.building_id LEFT JOIN payment_details pd ON pd.society_id=original.society_id AND pd.payment_id=original.id LEFT JOIN society_memberships collector ON collector.society_id=original.society_id AND collector.id=original.collected_by_membership_id LEFT JOIN users collector_user ON collector_user.id=collector.user_id LEFT JOIN membership_person_links collector_link ON collector_link.society_id=collector.society_id AND collector_link.membership_id=collector.id LEFT JOIN society_persons collector_person ON collector_person.society_id=collector.society_id AND collector_person.person_id=COALESCE(collector_link.person_id,collector_user.person_id)',
    values: [scope.societyId, scope.societyId, scope.societyId, scope.societyId],
    dateColumn: 'eventDate',
    moneyColumns: ['amount'],
    searchColumns: ['receiptNumber', 'reference', 'buildingCode', 'flatNumber', 'collectorName'],
  };
}
