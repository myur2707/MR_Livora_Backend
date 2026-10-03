import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { Session, RequestAudit } from '../auth/types.js';
import { rows, insert, notFound, utcTimestamp } from '../onboarding/repository.js';
import { sqlTime } from '../auth/repository.js';
import type { ResidentAccess } from './access.js';
import { type ResidentScope } from './access.js';
import { page } from './repository.js';
import type { ComplaintInput, PageQuery } from './contracts.js';
const noticeFields = 'id,title,body,published_at AS publishedAt';
const complaintFields =
  'c.id,c.flat_id AS flatId,c.title,c.description,c.status,c.created_at AS createdAt,c.resolved_at AS resolvedAt,f.flat_number AS flatNumber,building.code AS buildingCode';
const complaints =
  ' FROM complaints c JOIN flats f ON f.society_id=c.society_id AND f.id=c.flat_id JOIN buildings building ON building.society_id=f.society_id AND building.id=f.building_id WHERE c.society_id=? AND c.submitted_by_membership_id=? AND c.archived_at IS NULL';
function complaintView(row: RowDataPacket) {
  return {
    ...row,
    createdAt: utcTimestamp(row['createdAt']),
    resolvedAt: utcTimestamp(row['resolvedAt']),
  };
}
export class ResidentCommunity {
  constructor(readonly access: ResidentAccess) {}
  async feed(db: PoolConnection, scope: ResidentScope, query: PageQuery) {
    // Step 9 reads published society-wide notices only. Targeted publishing/committee
    // workflows belong to Step 10 and must introduce their own reviewed audience model.
    const result = await page<RowDataPacket>(
      db,
      'SELECT ' + noticeFields,
      " FROM notices WHERE society_id=? AND status='PUBLISHED' AND published_at<=?",
      [scope.societyId, sqlTime(this.access.clock())],
      query,
    );
    return {
      ...result,
      items: result.items.map((row) => ({ ...row, publishedAt: utcTimestamp(row['publishedAt']) })),
    };
  }
  async notices(session: Session, query: PageQuery) {
    return this.access.database.transaction(async (db) =>
      this.feed(db, await this.access.tenant(db, session), query),
    );
  }
  async notice(session: Session, id: string) {
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session);
      const found = await rows(
        db,
        'SELECT ' +
          noticeFields +
          " FROM notices WHERE society_id=? AND id=? AND status='PUBLISHED' AND published_at<=?",
        [scope.societyId, id, sqlTime(this.access.clock())],
      );
      if (!found[0]) throw notFound();
      return { ...found[0], publishedAt: utcTimestamp(found[0]['publishedAt']) };
    });
  }
  async complaints(session: Session, query: PageQuery) {
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session);
      const result = await page<RowDataPacket>(
        db,
        'SELECT ' + complaintFields,
        complaints,
        [scope.societyId, scope.membershipId],
        query,
      );
      return { ...result, items: result.items.map(complaintView) };
    });
  }
  async complaint(session: Session, id: string) {
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session);
      const found = await rows(db, 'SELECT ' + complaintFields + complaints + ' AND c.id=?', [
        scope.societyId,
        scope.membershipId,
        id,
      ]);
      if (!found[0]) throw notFound();
      return complaintView(found[0]);
    });
  }
  async submit(session: Session, input: ComplaintInput, audit: RequestAudit) {
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session);
      await this.access.flat(db, scope, input.flatId);
      const id = await insert(
        db,
        'INSERT INTO complaints(society_id,submitted_by_membership_id,flat_id,title,description,created_at) VALUES(?,?,?,?,?,?)',
        [
          scope.societyId,
          scope.membershipId,
          input.flatId,
          input.title,
          input.description,
          sqlTime(this.access.clock()),
        ],
      );
      await this.access.audit(db, scope, 'complaint.submitted', 'complaint', id, audit);
      return { id };
    });
  }
}
