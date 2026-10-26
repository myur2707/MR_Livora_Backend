import type { PoolConnection } from 'mysql2/promise';
import type { TenantScope } from '../property/access.js';
import type { Session } from '../auth/types.js';
import type { CommunityAccess } from '../community/access.js';
import { complaintStatus, complaintTables } from '../community/repository.js';
import { rows, utcTimestamp } from '../onboarding/repository.js';
import { sqlTime } from '../auth/repository.js';
import { ApiError } from '../http/errors.js';
import { BillingAccess } from '../billing/access.js';
import { reportQuery } from './contracts.js';
import { readReport } from './service.js';
import { occupancySource } from './people.js';
import { billSource, collectionSource } from './financial.js';
import { recentMonths } from './dates.js';

/** How many billing periods and calendar months the dashboard trends cover. */
const TREND_LENGTH = 6;
export class CommitteeDashboard {
  private readonly billing: BillingAccess;
  constructor(readonly access: CommunityAccess) {
    this.billing = new BillingAccess(access.database, access.clock);
  }
  async summary(session: Session) {
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session, 'society.dashboard.manage');
      const flats = await rows(
        db,
        'SELECT COUNT(*) AS total FROM flats f JOIN buildings b ON b.society_id=f.society_id AND b.id=f.building_id WHERE f.society_id=? AND f.archived_at IS NULL AND b.archived_at IS NULL',
        [scope.societyId],
      );
      const source = occupancySource(scope);
      const occupancy = await rows(
        db,
        'SELECT COUNT(*) AS occupancies,COUNT(DISTINCT flatId) AS occupiedFlats,COUNT(DISTINCT personId) AS persons FROM (' +
          source.sql +
          ") occupancy WHERE status='CURRENT'",
        source.values,
      );
      const types = await rows(
        db,
        'SELECT occupancyType,COUNT(*) AS total FROM (' +
          source.sql +
          ") occupancy WHERE status='CURRENT' GROUP BY occupancyType ORDER BY occupancyType",
        source.values,
      );
      const pending = await rows(
        db,
        'SELECT COUNT(*) AS total' +
          complaintTables +
          ' WHERE c.society_id=? AND c.archived_at IS NULL AND ' +
          complaintStatus +
          " IN ('NEW','ASSIGNED','IN_PROGRESS')",
        [scope.societyId],
      );
      const complaintStatuses = await rows(
        db,
        'SELECT ' +
          complaintStatus +
          ' AS status,COUNT(*) AS total' +
          complaintTables +
          ' WHERE c.society_id=? AND c.archived_at IS NULL GROUP BY status ORDER BY status',
        [scope.societyId],
      );
      const notices = await rows(
        db,
        "SELECT id,title,published_at AS publishedAt FROM notices WHERE society_id=? AND status='PUBLISHED' AND published_at<=? ORDER BY published_at DESC,id DESC LIMIT 5",
        [scope.societyId, sqlTime(this.access.clock())],
      );
      let finance: {
        billing: Record<string, string>;
        collections: Record<string, string>;
        cash: Record<string, string>;
        from: string;
        to: string;
      } | null = null;
      let canRead = false;
      try {
        await this.billing.tenant(db, session);
        canRead = true;
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 403 && error.code === 'ACCESS_DENIED'))
          throw error;
      }
      if (canRead) {
        const from = scope.today.slice(0, 7) + '-01',
          to = scope.today,
          query = reportQuery.parse({ pageSize: 1 });
        const billing = await readReport(db, scope, 'billing', query);
        const collections = await readReport(db, scope, 'collection', { ...query, from, to });
        const cash = await readReport(db, scope, 'cash-collection', { ...query, from, to });
        finance = {
          billing: billing.summary,
          collections: collections.summary,
          cash: cash.summary,
          from,
          to,
        };
      }
      // Chart aggregates go to every dashboard role (approved policy): society-level totals only,
      // never per-flat, per-person or receipt detail, which stay behind finance.read reports.
      const trends = await this.trends(db, scope);
      return {
        timezone: scope.timezone,
        asOf: scope.today,
        flats: Number(flats[0]?.['total'] ?? 0),
        occupancy: {
          occupiedFlats: Number(occupancy[0]?.['occupiedFlats'] ?? 0),
          occupancies: Number(occupancy[0]?.['occupancies'] ?? 0),
          persons: Number(occupancy[0]?.['persons'] ?? 0),
          types: types.map((row) => ({
            type: String(row['occupancyType']),
            total: Number(row['total']),
          })),
        },
        pendingComplaints: Number(pending[0]?.['total'] ?? 0),
        complaintStatuses: complaintStatuses.map((row) => ({
          status: String(row['status']),
          total: Number(row['total']),
        })),
        trends,
        recentNotices: notices.map((row) => ({
          ...row,
          publishedAt: utcTimestamp(row['publishedAt']),
        })),
        finance,
      };
    });
  }
  private async trends(db: PoolConnection, scope: TenantScope) {
    const source = billSource(scope);
    const statuses = await rows(
      db,
      'SELECT status,COUNT(*) AS total FROM (' +
        source.sql +
        ') bills GROUP BY status ORDER BY status',
      source.values,
    );
    // Issued bills only, matching the billing report's totals; collected is the settled share.
    const periods = await rows(
      db,
      'SELECT periodCode,CAST(SUM(net) AS DECIMAL(14,2)) AS billed,CAST(SUM(net-outstanding) AS DECIMAL(14,2)) AS collected,CAST(SUM(outstanding) AS DECIMAL(14,2)) AS outstanding FROM (' +
        source.sql +
        ") bills WHERE billStatus='ISSUED' GROUP BY periodId,periodCode ORDER BY MIN(startsOn) DESC,periodId DESC LIMIT ?",
      [...source.values, TREND_LENGTH],
    );
    const months = recentMonths(scope.today, TREND_LENGTH);
    const ledger = collectionSource(scope);
    const monthly = await rows(
      db,
      "SELECT DATE_FORMAT(eventDate,'%Y-%m') AS month,CAST(SUM(amount) AS DECIMAL(14,2)) AS netRecorded FROM (" +
        ledger.sql +
        ') ledger WHERE eventDate>=? AND eventDate<=? GROUP BY month',
      [...ledger.values, (months[0] ?? scope.today.slice(0, 7)) + '-01', scope.today],
    );
    const recorded = new Map(
      monthly.map((row) => [String(row['month']), String(row['netRecorded'])]),
    );
    return {
      billingStatuses: statuses.map((row) => ({
        status: String(row['status']),
        total: Number(row['total']),
      })),
      periods: periods.reverse().map((row) => ({
        periodCode: String(row['periodCode']),
        billed: String(row['billed']),
        collected: String(row['collected']),
        outstanding: String(row['outstanding']),
      })),
      monthlyCollections: months.map((month) => ({
        month,
        netRecorded: recorded.get(month) ?? '0.00',
      })),
    };
  }
}
