import type { ReportKind } from './contracts.js';
import type { ReportColumn } from './csv.js';
const columns = (...values: [string, string, ('text' | 'money' | 'date')?][]): ReportColumn[] =>
  values.map(([key, label, type]) => ({ key, label, type: type ?? 'text' }));
const billing = columns(
  ['billNumber', 'Bill'],
  ['buildingCode', 'Building'],
  ['flatNumber', 'Flat'],
  ['periodCode', 'Period'],
  ['startsOn', 'Period start', 'date'],
  ['dueOn', 'Due date', 'date'],
  ['status', 'Status'],
  ['gross', 'Original amount', 'money'],
  ['credits', 'Credits', 'money'],
  ['net', 'Net bill', 'money'],
  ['paid', 'Paid after returns', 'money'],
  ['outstanding', 'Outstanding', 'money'],
  ['creditBalance', 'Credit balance', 'money'],
);
const collection = columns(
  ['eventDate', 'Event date', 'date'],
  ['kind', 'Event'],
  ['receiptNumber', 'Receipt'],
  ['buildingCode', 'Building'],
  ['flatNumber', 'Flat'],
  ['method', 'Method'],
  ['collectorName', 'Collector'],
  ['reference', 'Reference'],
  ['amount', 'Signed amount', 'money'],
  ['dateSource', 'Date basis'],
);
export const reportColumns: Record<ReportKind, ReportColumn[]> = {
  billing,
  outstanding: billing,
  collection,
  'cash-collection': collection,
  payments: columns(
    ['eventDate', 'Payment date', 'date'],
    ['receiptNumber', 'Receipt'],
    ['buildingCode', 'Building'],
    ['flatNumber', 'Flat'],
    ['payerName', 'Payer'],
    ['method', 'Method'],
    ['reference', 'Reference'],
    ['status', 'Status'],
    ['amount', 'Original amount', 'money'],
    ['refunded', 'Refunded', 'money'],
    ['reversedAmount', 'Reversed', 'money'],
    ['netAmount', 'Current net amount', 'money'],
  ),
  residents: columns(
    ['displayName', 'Resident'],
    ['contactEmail', 'Contact email'],
    ['contactPhone', 'Contact phone'],
    ['createdAt', 'Created at UTC', 'date'],
    ['status', 'Status'],
  ),
  'flat-occupancy': columns(
    ['buildingCode', 'Building'],
    ['flatNumber', 'Flat'],
    ['displayName', 'Resident'],
    ['occupancyType', 'Occupancy'],
    ['startsOn', 'Start date', 'date'],
    ['endsOn', 'End date', 'date'],
    ['status', 'Current status'],
  ),
};
export function reportMetrics(kind: ReportKind): [string, string][] {
  if (kind === 'billing' || kind === 'outstanding')
    return [
      ['billed', "IF(billStatus='ISSUED',net,0)"],
      ['credits', "IF(billStatus='ISSUED',credits,0)"],
      ['paid', "IF(billStatus='ISSUED',paid,0)"],
      ['outstanding', "IF(billStatus='ISSUED',outstanding,0)"],
      ['creditBalance', "IF(billStatus='ISSUED',creditBalance,0)"],
    ];
  if (kind === 'payments')
    return [
      ['totalRecorded', 'amount'],
      ['refunds', 'refunded'],
      ['reversals', 'reversedAmount'],
      ['netRecorded', 'netAmount'],
    ];
  if (kind === 'collection' || kind === 'cash-collection')
    return [
      ['collections', "IF(kind='COLLECTION',amount,0)"],
      ['refunds', "IF(kind='REFUND',-amount,0)"],
      ['reversals', "IF(kind='REVERSAL',-amount,0)"],
      ['netRecorded', 'amount'],
    ];
  return [];
}
