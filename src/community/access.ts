import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { Session, Permission } from '../auth/types.js';
import { roleCapabilities, tenantRoles } from '../auth/types.js';
import { sqlTime } from '../auth/repository.js';
import { ApiError } from '../http/errors.js';
import { OnboardingRepository, rows } from '../onboarding/repository.js';
import { PropertyAccess, type TenantScope } from '../property/access.js';
import type { RuntimeDatabase } from '../database/runtime.js';
export class CommunityAccess {
  readonly audit;
  private readonly identity: OnboardingRepository;
  constructor(
    readonly database: RuntimeDatabase,
    readonly clock: () => number = Date.now,
  ) {
    this.identity = new OnboardingRepository(database, clock);
    const property = new PropertyAccess(database, clock);
    this.audit = property.audit.bind(property);
  }
  async tenant(db: PoolConnection, session: Session, permission: Permission): Promise<TenantScope> {
    const userId = await this.identity.actor(db, session);
    const current = await rows(
      db,
      'SELECT society_id FROM auth_sessions WHERE token_hash=? FOR SHARE',
      [session.hash],
    );
    const societyId: unknown = current[0]?.['society_id'];
    if (typeof societyId !== 'string')
      throw new ApiError(403, 'ACCESS_DENIED', 'Select an authorized society.');
    if (societyId !== session.societyId)
      throw new ApiError(
        409,
        'CONTEXT_CHANGED',
        'Society context changed. Refresh before trying again.',
      );
    const societies = await rows<RowDataPacket & { timezone: string }>(
      db,
      "SELECT timezone FROM societies WHERE id=? AND status='ACTIVE' AND archived_at IS NULL FOR UPDATE",
      [societyId],
    );
    const grants = await rows<RowDataPacket & { id: string; code: string }>(
      db,
      "SELECT m.id,r.code FROM society_memberships m JOIN users u ON u.id=m.user_id AND u.status='ACTIVE' LEFT JOIN membership_person_links l ON l.society_id=m.society_id AND l.membership_id=m.id JOIN society_persons sp ON sp.society_id=m.society_id AND sp.person_id=COALESCE(l.person_id,u.person_id) AND sp.archived_at IS NULL JOIN membership_roles mr ON mr.society_id=m.society_id AND mr.membership_id=m.id JOIN roles r ON r.society_id=mr.society_id AND r.id=mr.role_id AND r.archived_at IS NULL JOIN role_permissions rp ON rp.society_id=r.society_id AND rp.role_id=r.id JOIN permissions p ON p.id=rp.permission_id AND p.code=? WHERE m.society_id=? AND m.user_id=? AND m.status='ACTIVE' AND m.joined_at<=? AND m.ended_at IS NULL FOR SHARE",
      [permission, societyId, userId, sqlTime(this.clock())],
    );
    const grant = grants.find((g) =>
      tenantRoles.some((role) => role === g.code && roleCapabilities[role].includes(permission)),
    );
    const society = societies[0];
    if (!society || !grant) throw new ApiError(403, 'ACCESS_DENIED', 'Access is not permitted.');
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: society.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(this.clock()));
    const part = (key: string) => parts.find((p) => p.type === key)?.value ?? '';
    return {
      societyId,
      userId,
      membershipId: grant.id,
      timezone: society.timezone,
      today: part('year') + '-' + part('month') + '-' + part('day'),
    };
  }
}
