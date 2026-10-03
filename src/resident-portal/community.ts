import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { Session, RequestAudit } from '../auth/types.js';
import { rows, insert, notFound, utcTimestamp } from '../onboarding/repository.js';
import { sqlTime } from '../auth/repository.js';
import type { ResidentAccess } from './access.js';
import { type ResidentScope } from './access.js';
import { page } from './repository.js';
import type { ComplaintInput, PageQuery } from './contracts.js';
import {
  complaintStatus,
  complaintCategory,
  complaintTables,
  history,
  noticeAuthor,
} from '../community/repository.js';
const noticeFields = 'n.id,n.title,n.body,n.published_at AS publishedAt,' + noticeAuthor;
const complaintFields =
  'c.id,c.flat_id AS flatId,c.title,c.description,' +
  complaintStatus +
  ' AS status,' +
  complaintCategory +
  ' AS category,c.created_at AS createdAt,COALESCE(w.resolved_at,c.resolved_at) AS resolvedAt,f.flat_number AS flatNumber,building.code AS buildingCode';
const complaints =
  complaintTables +
  ' WHERE c.society_id=? AND c.submitted_by_membership_id=? AND c.archived_at IS NULL';
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
    // Publications are society-wide; drafts, future publications and archives stay private.
    const result = await page<RowDataPacket>(
      db,
      'SELECT ' + noticeFields,
      " FROM notices n WHERE n.society_id=? AND n.status='PUBLISHED' AND n.published_at<=?",
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
          " FROM notices n WHERE n.society_id=? AND n.id=? AND n.status='PUBLISHED' AND n.published_at<=?",
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
      const now = sqlTime(this.access.clock());
      await db.execute(
        "INSERT INTO complaint_workflows(society_id,complaint_id,category,status,updated_at) VALUES(?,?,?,'NEW',?)",
        [scope.societyId, id, input.category, now],
      );
      await db.execute(
        "INSERT INTO complaint_status_history(society_id,complaint_id,to_status,actor_membership_id,note,revision,created_at) VALUES(?,?,'NEW',?,'Complaint submitted',1,?)",
        [scope.societyId, id, scope.membershipId, now],
      );
      await this.access.audit(db, scope, 'complaint.submitted', 'complaint', id, audit);
      return { id };
    });
  }
  async history(session: Session, id: string, query: PageQuery) {
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session);
      if (
        !(
          await rows(db, 'SELECT c.id' + complaints + ' AND c.id=?', [
            scope.societyId,
            scope.membershipId,
            id,
          ])
        )[0]
      )
        throw notFound();
      return history(db, scope.societyId, id, query.page, query.pageSize);
    });
  }
}
