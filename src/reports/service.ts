import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { Session, RequestAudit } from '../auth/types.js';
import { BillingAccess } from '../billing/access.js';
import type { CommunityAccess } from '../community/access.js';
import { PropertyAccess, type TenantScope } from '../property/access.js';
import { rows, notFound, utcTimestamp } from '../onboarding/repository.js';
import { money } from '../billing/money.js';
import { ApiError } from '../http/errors.js';
import {
  financialReport,
  validateFilters,
  type ReportKind,
  type ReportQuery,
} from './contracts.js';
import { billSource, paymentSource, collectionSource, type ReportSource } from './financial.js';
import { residentsSource, occupancySource } from './people.js';
import { reportColumns, reportMetrics } from './definitions.js';
import { reportCsv, type ReportRow } from './csv.js';
import { utcRange } from './dates.js';
export const exportLimit = 5000;
export function decimalMoney(value: unknown): string {
  if (typeof value !== 'string' || !/^(-?)(\d+)(?:\.(\d{1,2}))?$/.test(value))
    throw new Error('Invalid report decimal.');
  const negative = value.startsWith('-'),
    [whole = '0', fraction = ''] = value.replace(/^-/, '').split('.');
  const units = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return money(negative ? -units : units);
}
function sourceFor(scope: TenantScope, kind: ReportKind): ReportSource {
  switch (kind) {
    case 'billing':
    case 'outstanding':
      return billSource(scope);
    case 'payments':
      return paymentSource(scope);
    case 'collection':
    case 'cash-collection':
      return collectionSource(scope);
    case 'residents':
      return residentsSource(scope);
    case 'flat-occupancy':
      return occupancySource(scope);
  }
}
async function validateReferences(
  db: PoolConnection,
  scope: TenantScope,
  query: ReportQuery,
): Promise<void> {
  for (const [table, id] of [
    ['buildings', query.buildingId],
    ['flats', query.flatId],
    ['billing_periods', query.periodId],
  ] as const)
    if (
      id &&
      !(
        await rows(db, 'SELECT id FROM ' + table + ' WHERE society_id=? AND id=?', [
          scope.societyId,
          id,
        ])
      )[0]
    )
      throw notFound();
  if (
    query.collectorUserId &&
    !(
      await rows(
        db,
        'SELECT m.id FROM society_memberships m WHERE m.society_id=? AND m.user_id=? AND EXISTS(SELECT 1 FROM payments p WHERE p.society_id=m.society_id AND p.collected_by_membership_id=m.id)',
        [scope.societyId, query.collectorUserId],
      )
    )[0]
  )
    throw notFound();
}
function filtered(
  source: ReportSource,
  scope: TenantScope,
  kind: ReportKind,
  query: ReportQuery,
): { sql: string; values: (string | number)[] } {
  const terms: string[] = [],
    values = [...source.values];
  for (const [column, value] of [
    ['buildingId', query.buildingId],
    ['flatId', query.flatId],
    ['periodId', query.periodId],
    ['collectedByUserId', query.collectorUserId],
    ['method', kind === 'cash-collection' ? 'CASH' : query.method],
    ['occupancyType', query.occupancyType],
  ] as const)
    if (value) {
      terms.push(column + '=?');
      values.push(value);
    }
  if (kind === 'outstanding') terms.push("billStatus='ISSUED' AND outstanding>0");
  if (query.status === 'ISSUED') terms.push("billStatus='ISSUED'");
  else if (query.status === 'OUTSTANDING') terms.push("billStatus='ISSUED' AND outstanding>0");
  else if (query.status !== 'ALL') {
    terms.push('status=?');
    values.push(query.status);
  }
  if (query.from && query.to) {
    if (kind === 'residents') {
      const [start, end] = utcRange(query.from, query.to, scope.timezone);
      terms.push('createdAt>=? AND createdAt<?');
      values.push(start, end);
    } else if (kind === 'flat-occupancy') {
      terms.push('startsOn<=? AND (endsOn IS NULL OR endsOn>=?)');
      values.push(query.to, query.from);
    } else {
      terms.push(source.dateColumn + '>=? AND ' + source.dateColumn + '<=?');
      values.push(query.from, query.to);
    }
  }
  if (query.q) {
    terms.push(
      '(' +
        source.searchColumns
          .map((column) => 'INSTR(COALESCE(' + column + ",''),?)>0")
          .join(' OR ') +
        ')',
    );
    values.push(...source.searchColumns.map(() => query.q));
  }
  return {
    sql:
      'SELECT * FROM (' +
      source.sql +
      ') report' +
      (terms.length ? ' WHERE ' + terms.join(' AND ') : ''),
    values,
  };
}
function normalize(row: RowDataPacket, kind: ReportKind, source: ReportSource): ReportRow {
  const result: ReportRow = { id: String(row['id']) };
  for (const column of reportColumns[kind]) {
    const value: unknown = row[column.key];
    if (value !== null && typeof value !== 'string' && typeof value !== 'number')
      throw new Error('Invalid report value.');
    result[column.key] = source.moneyColumns.includes(column.key)
      ? decimalMoney(value)
      : column.key === 'createdAt'
        ? utcTimestamp(value)
        : value;
  }
  return result;
}
export async function readReport(
  db: PoolConnection,
  scope: TenantScope,
  kind: ReportKind,
  query: ReportQuery,
  exporting = false,
) {
  validateFilters(kind, query);
  await validateReferences(db, scope, query);
  const source = sourceFor(scope, kind),
    filter = filtered(source, scope, kind, query),
    metrics = reportMetrics(kind);
  const totals = await rows(
    db,
    'SELECT COUNT(*) AS total' +
      metrics
        .map(([key, expression]) => ',COALESCE(SUM(' + expression + '),0) AS ' + key)
        .join('') +
      ' FROM (' +
      filter.sql +
      ') totals',
    filter.values,
  );
  const total = Number(totals[0]?.['total'] ?? 0);
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('Unsafe report count.');
  if (exporting && total > exportLimit)
    throw new ApiError(
      422,
      'EXPORT_TOO_LARGE',
      'Narrow the filters to export at most 5000 records.',
    );
  const sort =
    query.sort === 'date'
      ? source.dateColumn
      : query.sort === 'name'
        ? source.nameColumn
        : query.sort === 'amount'
          ? kind === 'billing' || kind === 'outstanding'
            ? 'gross'
            : 'amount'
          : query.sort;
  if (!sort) throw new ApiError(400, 'INVALID_REQUEST', 'Unsupported report sort.');
  const entries = await rows(
    db,
    filter.sql +
      ' ORDER BY ' +
      sort +
      ' ' +
      query.direction +
      ',id ' +
      query.direction +
      (['collection', 'cash-collection'].includes(kind) ? ',kind ' + query.direction : '') +
      ' LIMIT ? OFFSET ?',
    [
      ...filter.values,
      exporting ? exportLimit : query.pageSize,
      exporting ? 0 : (query.page - 1) * query.pageSize,
    ],
  );
  return {
    kind,
    columns: reportColumns[kind],
    items: entries.map((row) => normalize(row, kind, source)),
    total,
    page: exporting ? 1 : query.page,
    pageSize: exporting ? exportLimit : query.pageSize,
    summary: Object.fromEntries(metrics.map(([key]) => [key, decimalMoney(totals[0]?.[key])])),
    timezone: scope.timezone,
    asOf: scope.today,
    range: { from: query.from ?? null, to: query.to ?? null },
  };
}
export class ReportService {
  readonly billing: BillingAccess;
  readonly property: PropertyAccess;
  constructor(readonly access: CommunityAccess) {
    this.billing = new BillingAccess(access.database, access.clock);
    this.property = new PropertyAccess(access.database, access.clock);
  }
  private scope(db: PoolConnection, session: Session, kind: ReportKind): Promise<TenantScope> {
    return financialReport(kind)
      ? this.billing.tenant(db, session)
      : this.property.tenant(db, session);
  }
  async list(session: Session, kind: ReportKind, query: ReportQuery) {
    return this.access.database.transaction(async (db) =>
      readReport(db, await this.scope(db, session, kind), kind, query),
    );
  }
  async export(session: Session, kind: ReportKind, query: ReportQuery, audit: RequestAudit) {
    return this.access.database.transaction(async (db) => {
      await this.access.tenant(db, session, 'society.reports.export');
      const scope = await this.scope(db, session, kind);
      const result = await readReport(db, scope, kind, query, true);
      await this.access.audit(db, scope, 'report.exported', 'report', scope.societyId, audit, {
        kind,
        rows: result.total,
        from: query.from ?? null,
        to: query.to ?? null,
      });
      return reportCsv(result.columns, result.items);
    });
  }
}
