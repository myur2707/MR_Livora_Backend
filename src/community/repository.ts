import type { PoolConnection } from 'mysql2/promise';
import { rows, utcTimestamp } from '../onboarding/repository.js';
export const noticeAuthor =
  "COALESCE((SELECT sp.display_name FROM society_memberships author JOIN users author_user ON author_user.id=author.user_id LEFT JOIN membership_person_links link ON link.society_id=author.society_id AND link.membership_id=author.id JOIN society_persons sp ON sp.society_id=author.society_id AND sp.person_id=COALESCE(link.person_id,author_user.person_id) WHERE author.society_id=n.society_id AND author.id=n.created_by_membership_id LIMIT 1),'Committee') AS authorName";
export const complaintStatus =
  "COALESCE(w.status,CASE WHEN c.status='OPEN' THEN 'NEW' ELSE c.status END)";
export const complaintCategory = "COALESCE(w.category,'OTHER')";
export const complaintFields =
  'c.id,c.flat_id AS flatId,c.title,c.description,' +
  complaintStatus +
  ' AS status,' +
  complaintCategory +
  ' AS category,COALESCE(w.revision,1) AS revision,w.assigned_to_membership_id AS assigneeMembershipId,c.created_at AS createdAt,COALESCE(w.resolved_at,c.resolved_at) AS resolvedAt,f.flat_number AS flatNumber,building.code AS buildingCode';
export const complaintTables =
  ' FROM complaints c LEFT JOIN complaint_workflows w ON w.society_id=c.society_id AND w.complaint_id=c.id JOIN flats f ON f.society_id=c.society_id AND f.id=c.flat_id JOIN buildings building ON building.society_id=f.society_id AND building.id=f.building_id';
export async function history(
  db: PoolConnection,
  societyId: string,
  complaintId: string,
  page: number,
  pageSize: number,
) {
  const values = [societyId, complaintId];
  const count = await rows(
    db,
    'SELECT COUNT(*) AS total FROM complaint_status_history WHERE society_id=? AND complaint_id=?',
    values,
  );
  const entries = await rows(
    db,
    'SELECT id,from_status AS fromStatus,to_status AS toStatus,note,revision,created_at AS createdAt FROM complaint_status_history WHERE society_id=? AND complaint_id=? ORDER BY revision DESC LIMIT ? OFFSET ?',
    [...values, pageSize, (page - 1) * pageSize],
  );
  return {
    items: entries.map((item) => ({ ...item, createdAt: utcTimestamp(item['createdAt']) })),
    total: Number(count[0]?.['total'] ?? 0),
    page,
    pageSize,
  };
}
