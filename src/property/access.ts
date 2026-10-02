import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { RuntimeDatabase } from '../database/runtime.js';
import type { Session, RequestAudit } from '../auth/types.js';
import { ApiError } from '../http/errors.js';
import { OnboardingRepository, rows } from '../onboarding/repository.js';
import { sqlTime } from '../auth/repository.js';
export interface TenantScope {
  societyId: string;
  userId: string;
  membershipId: string;
  timezone: string;
  today: string;
}
interface ScopeRow extends RowDataPacket {
  id: string;
  timezone: string;
}
export class PropertyAccess {
  private readonly identity: OnboardingRepository;
  constructor(
    readonly database: RuntimeDatabase,
    readonly clock: () => number = Date.now,
  ) {
    this.identity = new OnboardingRepository(database, clock);
  }
  async tenant(db: PoolConnection, session: Session, write = false): Promise<TenantScope> {
    const userId = await this.identity.actor(db, session);
    const current = await rows<RowDataPacket & { society_id: string | null }>(
      db,
      'SELECT society_id FROM auth_sessions WHERE token_hash=?',
      [session.hash],
    );
    const societyId = current[0]?.society_id;
    if (!societyId) throw new ApiError(403, 'ACCESS_DENIED', 'Select an authorized society.');
    if (societyId !== session.societyId)
      throw new ApiError(
        409,
        'CONTEXT_CHANGED',
        'Society context changed. Refresh before trying again.',
      );
    const societies = await rows<ScopeRow>(
      db,
      "SELECT id,timezone FROM societies WHERE id=? AND status='ACTIVE' AND archived_at IS NULL " +
        (write ? 'FOR UPDATE' : 'FOR SHARE'),
      [societyId],
    );
    const society = societies[0];
    if (!society) throw new ApiError(403, 'ACCESS_DENIED', 'Access is not permitted.');
    const members = await rows<RowDataPacket & { id: string }>(
      db,
      "SELECT m.id FROM society_memberships m JOIN users u ON u.id=m.user_id AND u.status='ACTIVE' LEFT JOIN membership_person_links l ON l.society_id=m.society_id AND l.membership_id=m.id JOIN society_persons sp ON sp.society_id=m.society_id AND sp.person_id=COALESCE(l.person_id,u.person_id) AND sp.archived_at IS NULL JOIN membership_roles mr ON mr.society_id=m.society_id AND mr.membership_id=m.id JOIN roles r ON r.society_id=mr.society_id AND r.id=mr.role_id AND r.code='COMMITTEE_ADMIN' AND r.archived_at IS NULL JOIN role_permissions rp ON rp.society_id=r.society_id AND rp.role_id=r.id JOIN permissions p ON p.id=rp.permission_id AND p.code='society.members.manage' WHERE m.society_id=? AND m.user_id=? AND m.status='ACTIVE' AND m.joined_at<=? AND m.ended_at IS NULL FOR SHARE",
      [societyId, userId, sqlTime(this.clock())],
    );
    const membershipId = members[0]?.id;
    if (!membershipId) throw new ApiError(403, 'ACCESS_DENIED', 'Access is not permitted.');
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: society.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(this.clock()));
    const datePart = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    return {
      societyId,
      userId,
      membershipId,
      timezone: society.timezone,
      today: datePart('year') + '-' + datePart('month') + '-' + datePart('day'),
    };
  }
  async audit(
    db: PoolConnection,
    scope: TenantScope,
    action: string,
    entityType: string,
    entityId: string,
    audit: RequestAudit,
    metadata: object = {},
  ): Promise<void> {
    await db.execute(
      'INSERT INTO audit_logs(society_id,actor_user_id,action,entity_type,entity_id,request_id,safe_metadata,created_at) VALUES(?,?,?,?,?,?,?,?)',
      [
        scope.societyId,
        scope.userId,
        action,
        entityType,
        entityId,
        audit.requestId,
        JSON.stringify(metadata),
        sqlTime(this.clock()),
      ],
    );
  }
}
