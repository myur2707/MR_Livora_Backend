import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { Session } from '../auth/types.js';
import { sqlTime } from '../auth/repository.js';
import { ApiError } from '../http/errors.js';
import { OnboardingRepository, rows, notFound } from '../onboarding/repository.js';
import type { RuntimeDatabase } from '../database/runtime.js';
import { PropertyAccess, type TenantScope } from '../property/access.js';
import { roleCapabilities, tenantRoles } from '../auth/types.js';

export interface ResidentScope extends TenantScope {
  personId: string;
  societyName: string;
}
export class ResidentAccess {
  private readonly identity: OnboardingRepository;
  readonly audit;
  constructor(
    readonly database: RuntimeDatabase,
    readonly clock: () => number = Date.now,
  ) {
    this.identity = new OnboardingRepository(database, clock);
    const property = new PropertyAccess(database, clock);
    this.audit = property.audit.bind(property);
  }
  async tenant(db: PoolConnection, session: Session): Promise<ResidentScope> {
    const userId = await this.identity.actor(db, session);
    const current = await rows<RowDataPacket & { society_id: string | null }>(
      db,
      'SELECT society_id FROM auth_sessions WHERE token_hash=? FOR SHARE',
      [session.hash],
    );
    const societyId = current[0]?.society_id;
    if (!societyId) throw new ApiError(403, 'ACCESS_DENIED', 'Select an authorized society.');
    if (societyId !== session.societyId)
      throw new ApiError(
        409,
        'CONTEXT_CHANGED',
        'Society context changed. Refresh before continuing.',
      );
    const societies = await rows<RowDataPacket & { timezone: string; name: string }>(
      db,
      "SELECT timezone,name FROM societies WHERE id=? AND status='ACTIVE' AND archived_at IS NULL FOR SHARE",
      [societyId],
    );
    const grants = await rows<RowDataPacket & { id: string; personId: string; code: string }>(
      db,
      "SELECT m.id,sp.person_id AS personId,r.code FROM society_memberships m JOIN users u ON u.id=m.user_id AND u.status='ACTIVE' LEFT JOIN membership_person_links l ON l.society_id=m.society_id AND l.membership_id=m.id JOIN society_persons sp ON sp.society_id=m.society_id AND sp.person_id=COALESCE(l.person_id,u.person_id) AND sp.archived_at IS NULL JOIN membership_roles mr ON mr.society_id=m.society_id AND mr.membership_id=m.id JOIN roles r ON r.society_id=mr.society_id AND r.id=mr.role_id AND r.archived_at IS NULL JOIN role_permissions rp ON rp.society_id=r.society_id AND rp.role_id=r.id JOIN permissions p ON p.id=rp.permission_id AND p.code='society.dashboard.read' WHERE m.society_id=? AND m.user_id=? AND m.status='ACTIVE' AND m.joined_at<=? AND m.ended_at IS NULL FOR SHARE",
      [societyId, userId, sqlTime(this.clock())],
    );
    const grant = grants.find((g) =>
      tenantRoles.some(
        (role) => role === g.code && roleCapabilities[role].includes('society.dashboard.read'),
      ),
    );
    const society = societies[0];
    if (!grant || !society) throw new ApiError(403, 'ACCESS_DENIED', 'Access is not permitted.');
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: society.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(this.clock()));
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return {
      userId,
      societyId,
      membershipId: grant.id,
      personId: grant.personId,
      societyName: society.name,
      timezone: society.timezone,
      today: part('year') + '-' + part('month') + '-' + part('day'),
    };
  }
  async flat(db: PoolConnection, scope: ResidentScope, id: string): Promise<void> {
    const policy = flatPolicy(scope);
    const found = await rows(
      db,
      'SELECT f.id FROM flats f JOIN buildings building ON building.society_id=f.society_id AND building.id=f.building_id WHERE f.society_id=? AND f.id=? AND ' +
        policy.sql,
      [scope.societyId, id, ...policy.values],
    );
    if (!found.length) throw notFound();
  }
}
// Identifiers below are fixed SQL aliases, never request input. Date access is independent
// of a RESIDENT role: committee members with their own approved occupancy use the same policy.
export function flatPolicy(scope: ResidentScope, bill = false) {
  return {
    sql:
      'f.archived_at IS NULL AND building.archived_at IS NULL AND EXISTS(SELECT 1 FROM flat_occupancies o WHERE o.society_id=f.society_id AND o.flat_id=f.id AND o.person_id=? AND o.starts_on<=? AND (o.ends_on IS NULL OR o.ends_on>=?)' +
      (bill
        ? ' AND p.starts_on>=o.starts_on AND (o.ends_on IS NULL OR p.starts_on<=o.ends_on)'
        : '') +
      ')',
    values: [scope.personId, scope.today, scope.today],
  };
}
