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
import { billSource } from './financial.js';
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
      const notices = await rows(
        db,
        "SELECT id,title,published_at AS publishedAt FROM notices WHERE society_id=? AND status='PUBLISHED' AND published_at<=? ORDER BY published_at DESC,id DESC LIMIT 5",
        [scope.societyId, sqlTime(this.access.clock())],
      );
      let finance: {
        billing: Record<string, string>;
        billingStatuses: { status: string; total: number }[];
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
        const source = billSource(scope);
        const statuses = await rows(
          db,
          'SELECT status,COUNT(*) AS total FROM (' +
            source.sql +
            ') bills GROUP BY status ORDER BY status',
          source.values,
        );
        finance = {
          billing: billing.summary,
          billingStatuses: statuses.map((row) => ({
            status: String(row['status']),
            total: Number(row['total']),
          })),
          collections: collections.summary,
          cash: cash.summary,
          from,
          to,
        };
      }
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
        recentNotices: notices.map((row) => ({
          ...row,
          publishedAt: utcTimestamp(row['publishedAt']),
        })),
        finance,
      };
    });
  }
}
