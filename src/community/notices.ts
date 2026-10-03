import type { RowDataPacket } from 'mysql2/promise';
import type { Session, RequestAudit } from '../auth/types.js';
import { sqlTime } from '../auth/repository.js';
import { ApiError } from '../http/errors.js';
import { insert, rows, notFound, utcTimestamp } from '../onboarding/repository.js';
import { page } from '../resident-portal/repository.js';
import type { CommunityAccess } from './access.js';
import type { NoticeInput, NoticeQuery } from './contracts.js';
import { noticeAuthor } from './repository.js';
const fields =
  'n.id,n.title,n.body,n.status,n.created_by_membership_id AS authorMembershipId,n.created_at AS createdAt,n.published_at AS publishedAt,COALESCE(d.revision,1) AS revision,d.updated_at AS updatedAt,' +
  noticeAuthor;
const source =
  ' FROM notices n LEFT JOIN notice_details d ON d.society_id=n.society_id AND d.notice_id=n.id WHERE n.society_id=?';
const view = (row: RowDataPacket) => ({
  ...row,
  revision: Number(row['revision']),
  createdAt: utcTimestamp(row['createdAt']),
  publishedAt: utcTimestamp(row['publishedAt']),
  updatedAt: utcTimestamp(row['updatedAt']),
});
export class CommunityNotices {
  constructor(readonly access: CommunityAccess) {}
  async list(session: Session, query: NoticeQuery) {
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session, 'society.notices.manage');
      const result = await page(
        db,
        'SELECT ' + fields,
        source + " AND (?='ALL' OR n.status=?) AND (?='' OR INSTR(n.title,?)>0)",
        [scope.societyId, query.status, query.status, query.search, query.search],
        query,
      );
      return { ...result, items: result.items.map(view) };
    });
  }
  async detail(session: Session, id: string) {
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session, 'society.notices.manage');
      const found = await rows(db, 'SELECT ' + fields + source + ' AND n.id=?', [
        scope.societyId,
        id,
      ]);
      if (!found[0]) throw notFound();
      return view(found[0]);
    });
  }
  async create(session: Session, input: NoticeInput, audit: RequestAudit) {
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session, 'society.notices.manage');
      const now = sqlTime(this.access.clock());
      const id = await insert(
        db,
        'INSERT INTO notices(society_id,title,body,created_by_membership_id,created_at) VALUES(?,?,?,?,?)',
        [scope.societyId, input.title, input.body, scope.membershipId, now],
      );
      await db.execute(
        'INSERT INTO notice_details(society_id,notice_id,updated_by_membership_id,updated_at) VALUES(?,?,?,?)',
        [scope.societyId, id, scope.membershipId, now],
      );
      await this.access.audit(db, scope, 'notice.created', 'notice', id, audit, { revision: 1 });
      return { id, revision: 1 };
    });
  }
  async change(
    session: Session,
    id: string,
    revision: number,
    audit: RequestAudit,
    change: NoticeInput | { action: 'PUBLISH' | 'ARCHIVE' },
  ) {
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session, 'society.notices.manage');
      const found = await rows<RowDataPacket & { status: string; revision: number }>(
        db,
        'SELECT n.status,COALESCE(d.revision,1) AS revision' + source + ' AND n.id=? FOR UPDATE',
        [scope.societyId, id],
      );
      const current = found[0];
      if (!current) throw notFound();
      if (Number(current.revision) !== revision)
        throw new ApiError(409, 'REVISION_CONFLICT', 'This notice changed. Reload before saving.');
      if (
        current.status === 'ARCHIVED' ||
        ('action' in change && change.action === 'PUBLISH' && current.status !== 'DRAFT')
      )
        throw new ApiError(409, 'INVALID_TRANSITION', 'This notice action is not permitted.');
      const now = sqlTime(this.access.clock());
      if ('action' in change)
        await db.execute(
          "UPDATE notices SET status=?,published_at=CASE WHEN ?='PUBLISHED' THEN ? ELSE published_at END WHERE society_id=? AND id=?",
          [
            change.action === 'PUBLISH' ? 'PUBLISHED' : 'ARCHIVED',
            change.action === 'PUBLISH' ? 'PUBLISHED' : 'ARCHIVED',
            now,
            scope.societyId,
            id,
          ],
        );
      else
        await db.execute('UPDATE notices SET title=?,body=? WHERE society_id=? AND id=?', [
          change.title,
          change.body,
          scope.societyId,
          id,
        ]);
      await db.execute(
        'INSERT INTO notice_details(society_id,notice_id,revision,updated_by_membership_id,updated_at) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE revision=VALUES(revision),updated_by_membership_id=VALUES(updated_by_membership_id),updated_at=VALUES(updated_at)',
        [scope.societyId, id, revision + 1, scope.membershipId, now],
      );
      await this.access.audit(
        db,
        scope,
        'notice.' + ('action' in change ? change.action.toLowerCase() : 'edited'),
        'notice',
        id,
        audit,
        { revision: revision + 1, previousStatus: current.status },
      );
      return { id, revision: revision + 1 };
    });
  }
}
