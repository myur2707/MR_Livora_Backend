import type { RowDataPacket } from 'mysql2/promise';
import type { Session, RequestAudit } from '../auth/types.js';
import { sqlTime } from '../auth/repository.js';
import { ApiError } from '../http/errors.js';
import { rows, notFound, utcTimestamp } from '../onboarding/repository.js';
import { page } from '../resident-portal/repository.js';
import type { PageQuery } from '../resident-portal/contracts.js';
import type { CommunityAccess } from './access.js';
import type { ComplaintAction, ComplaintQuery } from './contracts.js';
import { canTransition, type ComplaintStatus } from './policy.js';
import {
  complaintFields,
  complaintTables,
  complaintStatus,
  complaintCategory,
  history,
} from './repository.js';
const assignees =
  " FROM society_memberships m JOIN users u ON u.id=m.user_id AND u.status='ACTIVE' LEFT JOIN membership_person_links l ON l.society_id=m.society_id AND l.membership_id=m.id JOIN society_persons sp ON sp.society_id=m.society_id AND sp.person_id=COALESCE(l.person_id,u.person_id) AND sp.archived_at IS NULL WHERE m.society_id=? AND m.status='ACTIVE' AND m.ended_at IS NULL AND m.joined_at<=? AND EXISTS(SELECT 1 FROM membership_roles mr JOIN roles r ON r.society_id=mr.society_id AND r.id=mr.role_id AND r.archived_at IS NULL AND r.code IN ('COMMITTEE_ADMIN','COMMITTEE_MEMBER') JOIN role_permissions rp ON rp.society_id=r.society_id AND rp.role_id=r.id JOIN permissions p ON p.id=rp.permission_id AND p.code='society.complaints.manage' WHERE mr.society_id=m.society_id AND mr.membership_id=m.id)";
export const complaintView = (row: RowDataPacket) => ({
  ...row,
  revision: Number(row['revision']),
  createdAt: utcTimestamp(row['createdAt']),
  resolvedAt: utcTimestamp(row['resolvedAt']),
});
interface ComplaintRow extends RowDataPacket {
  status: ComplaintStatus;
  revision: number;
  assigneeMembershipId: string | null;
  resolvedAt: string | null;
}
export class CommitteeComplaints {
  constructor(readonly access: CommunityAccess) {}
  async assignees(session: Session, query: PageQuery) {
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session, 'society.complaints.manage');
      return page(
        db,
        'SELECT m.id,sp.display_name AS displayName',
        assignees,
        [scope.societyId, sqlTime(this.access.clock())],
        query,
      );
    });
  }
  async list(session: Session, query: ComplaintQuery) {
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session, 'society.complaints.manage');
      const result = await page(
        db,
        'SELECT ' + complaintFields,
        complaintTables +
          " WHERE c.society_id=? AND c.archived_at IS NULL AND (?='ALL' OR " +
          complaintStatus +
          "=?) AND (?='ALL' OR " +
          complaintCategory +
          '=?)',
        [scope.societyId, query.status, query.status, query.category, query.category],
        query,
      );
      return { ...result, items: result.items.map(complaintView) };
    });
  }
  async detail(session: Session, id: string) {
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session, 'society.complaints.manage');
      const found = await rows(
        db,
        'SELECT ' +
          complaintFields +
          complaintTables +
          ' WHERE c.society_id=? AND c.id=? AND c.archived_at IS NULL',
        [scope.societyId, id],
      );
      if (!found[0]) throw notFound();
      return complaintView(found[0]);
    });
  }
  async history(session: Session, id: string, query: PageQuery) {
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session, 'society.complaints.manage');
      if (
        !(
          await rows(
            db,
            'SELECT id FROM complaints WHERE society_id=? AND id=? AND archived_at IS NULL',
            [scope.societyId, id],
          )
        )[0]
      )
        throw notFound();
      return history(db, scope.societyId, id, query.page, query.pageSize);
    });
  }
  async change(session: Session, id: string, input: ComplaintAction, audit: RequestAudit) {
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session, 'society.complaints.manage');
      const found = await rows<ComplaintRow>(
        db,
        'SELECT ' +
          complaintFields +
          complaintTables +
          ' WHERE c.society_id=? AND c.id=? AND c.archived_at IS NULL',
        [scope.societyId, id],
      );
      const current = found[0];
      if (!current) throw notFound();
      if (Number(current.revision) !== input.revision)
        throw new ApiError(
          409,
          'REVISION_CONFLICT',
          'This complaint changed. Reload before saving.',
        );
      const reassign =
        current.status === input.status &&
        ['ASSIGNED', 'IN_PROGRESS'].includes(input.status) &&
        input.assigneeMembershipId !== undefined &&
        input.assigneeMembershipId !== current.assigneeMembershipId;
      if (!canTransition(current.status, input.status) && !reassign)
        throw new ApiError(409, 'INVALID_TRANSITION', 'Follow the complaint status sequence.');
      if (
        input.assigneeMembershipId !== undefined &&
        !['ASSIGNED', 'IN_PROGRESS'].includes(input.status)
      )
        throw new ApiError(400, 'INVALID_REQUEST', 'Assignment is not permitted for this status.');
      const assigned = input.assigneeMembershipId ?? current.assigneeMembershipId;
      if (['ASSIGNED', 'IN_PROGRESS'].includes(input.status) && !assigned)
        throw new ApiError(400, 'INVALID_REQUEST', 'Choose an authorized committee assignee.');
      const now = sqlTime(this.access.clock());
      if (
        assigned &&
        !(
          await rows(db, 'SELECT m.id' + assignees + ' AND m.id=? FOR SHARE', [
            scope.societyId,
            now,
            assigned,
          ])
        )[0]
      )
        throw new ApiError(
          400,
          'INVALID_ASSIGNEE',
          'Choose an active authorized committee assignee.',
        );
      const resolved = input.status === 'RESOLVED' ? now : current.resolvedAt;
      await db.execute(
        "INSERT INTO complaint_workflows(society_id,complaint_id,category,status,assigned_to_membership_id,revision,resolved_at,updated_at) VALUES(?,?,'OTHER',?,?,?,?,?) ON DUPLICATE KEY UPDATE status=VALUES(status),assigned_to_membership_id=VALUES(assigned_to_membership_id),revision=VALUES(revision),resolved_at=VALUES(resolved_at),updated_at=VALUES(updated_at)",
        [scope.societyId, id, input.status, assigned, input.revision + 1, resolved, now],
      );
      await db.execute(
        'INSERT INTO complaint_status_history(society_id,complaint_id,from_status,to_status,assigned_to_membership_id,actor_membership_id,note,revision,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        [
          scope.societyId,
          id,
          current.status,
          input.status,
          assigned,
          scope.membershipId,
          input.note,
          input.revision + 1,
          now,
        ],
      );
      await this.access.audit(
        db,
        scope,
        reassign ? 'complaint.reassigned' : 'complaint.status_changed',
        'complaint',
        id,
        audit,
        {
          from: current.status,
          to: input.status,
          revision: input.revision + 1,
          assigneeMembershipId: assigned,
        },
      );
      return { id, revision: input.revision + 1 };
    });
  }
}
