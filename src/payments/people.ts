import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { TenantScope } from '../property/access.js';
import { rows, notFound } from '../onboarding/repository.js';
import { sqlTime } from '../auth/repository.js';
export const collectorSource = ` FROM society_memberships m JOIN users u ON u.id=m.user_id AND u.status='ACTIVE'
 LEFT JOIN membership_person_links l ON l.society_id=m.society_id AND l.membership_id=m.id
 JOIN society_persons sp ON sp.society_id=m.society_id AND sp.person_id=COALESCE(l.person_id,u.person_id) AND sp.archived_at IS NULL
 WHERE m.society_id=? AND m.status='ACTIVE' AND m.ended_at IS NULL AND m.joined_at<=?
 AND EXISTS(SELECT 1 FROM membership_roles mr JOIN roles r ON r.society_id=mr.society_id AND r.id=mr.role_id AND r.archived_at IS NULL AND r.code IN ('COMMITTEE_ADMIN','ACCOUNTANT')
 JOIN role_permissions rp ON rp.society_id=r.society_id AND rp.role_id=r.id JOIN permissions p ON p.id=rp.permission_id AND p.code='society.finance.record'
 WHERE mr.society_id=m.society_id AND mr.membership_id=m.id)`;
export async function collector(
  db: PoolConnection,
  scope: TenantScope,
  userId: string,
  now: number,
) {
  const found = await rows<RowDataPacket & { id: string; name: string }>(
    db,
    // Another recorder may hold the collector's global user lock while waiting for this society.
    // Lock tenant membership/profile rows only; user status is read after the society lock.
    'SELECT m.id,sp.display_name AS name' +
      collectorSource +
      ' AND m.user_id=? FOR SHARE OF m,l,sp',
    [scope.societyId, sqlTime(now), userId],
  );
  if (!found[0]) throw notFound();
  return found[0];
}
export async function paymentPeople(
  db: PoolConnection,
  scope: TenantScope,
  flatId: string,
  payerId: string,
) {
  const flats = await rows<
    RowDataPacket & {
      buildingCode: string;
      flatNumber: string;
      societyName: string;
      currency: string;
    }
  >(
    db,
    "SELECT b.code AS buildingCode,f.flat_number AS flatNumber,s.name AS societyName,'INR' AS currency FROM flats f JOIN buildings b ON b.society_id=f.society_id AND b.id=f.building_id JOIN societies s ON s.id=f.society_id WHERE f.society_id=? AND f.id=? AND f.archived_at IS NULL AND b.archived_at IS NULL FOR SHARE",
    [scope.societyId, flatId],
  );
  const payers = await rows<RowDataPacket & { name: string }>(
    db,
    'SELECT sp.display_name AS name FROM society_persons sp WHERE sp.society_id=? AND sp.person_id=? AND sp.archived_at IS NULL FOR SHARE',
    [scope.societyId, payerId],
  );
  const flat = flats[0],
    payer = payers[0];
  if (!flat || !payer) throw notFound();
  const recorders = await rows<RowDataPacket & { name: string }>(
    db,
    'SELECT sp.display_name AS name FROM society_memberships m JOIN users u ON u.id=m.user_id LEFT JOIN membership_person_links l ON l.society_id=m.society_id AND l.membership_id=m.id JOIN society_persons sp ON sp.society_id=m.society_id AND sp.person_id=COALESCE(l.person_id,u.person_id) WHERE m.society_id=? AND m.id=?',
    [scope.societyId, scope.membershipId],
  );
  return { ...flat, payerName: payer.name, recorderName: recorders[0]?.name ?? 'Committee' };
}
