import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { RuntimeDatabase } from '../database/runtime.js';
import type { Session, RequestAudit } from '../auth/types.js';
import { sqlTime } from '../auth/repository.js';
import { ApiError } from '../http/errors.js';
import type { SocietyStatus, PageInput } from './contracts.js';
import type { Requirements } from './policy.js';
export type Scope = 'platform' | 'committee';
export interface SetupRow extends RowDataPacket {
  society_id: string;
  code: string;
  name: string;
  timezone: string;
  status: SocietyStatus;
  revision: string;
  residents_confirmed: number;
  maintenance_confirmed: number;
  reviewed_revision: string | null;
  reviewed_by_membership_id: string | null;
  reviewed_at: string | null;
  verified_by_membership_id: string | null;
  verified_at: string | null;
}
export interface Actor {
  userId: string;
  membershipId: string | null;
}
export interface CountRow extends RowDataPacket {
  buildings: number;
  flats: number;
  residents: number;
  maintenance: number;
  emptyBuildings: number;
  missingAreas: number;
  committee: number;
  perArea: number;
}
type Values = (string | number | Buffer | null)[];
export async function rows<T extends RowDataPacket>(
  db: PoolConnection,
  sql: string,
  values: Values = [],
): Promise<T[]> {
  return (await db.execute<T[]>(sql, values))[0];
}
export async function insert(
  db: PoolConnection,
  sql: string,
  values: Values = [],
): Promise<string> {
  const [result] = await db.execute<ResultSetHeader>(sql, values);
  if (!Number.isSafeInteger(result.insertId) || result.insertId <= 0)
    throw new Error('Unsafe identifier.');
  return String(result.insertId);
}
export function utcTimestamp(value: unknown): string | null {
  return typeof value === 'string' ? new Date(value.replace(' ', 'T') + 'Z').toISOString() : null;
}
export const notFound = () => new ApiError(404, 'NOT_FOUND', 'Resource not found.');
export class OnboardingRepository {
  constructor(
    readonly database: RuntimeDatabase,
    readonly clock: () => number = Date.now,
  ) {}
  async actor(db: PoolConnection, session: Session): Promise<string> {
    if (!session.userId) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    const user = await rows(db, "SELECT id FROM users WHERE id=? AND status='ACTIVE' FOR UPDATE", [
      session.userId,
    ]);
    const active = await rows(
      db,
      'SELECT token_hash FROM auth_sessions WHERE token_hash=? AND user_id=? AND revoked_at IS NULL AND idle_expires_at>? AND absolute_expires_at>? FOR UPDATE',
      [session.hash, session.userId, sqlTime(this.clock()), sqlTime(this.clock())],
    );
    if (!user.length || !active.length)
      throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    return session.userId;
  }
  async platform(db: PoolConnection, session: Session): Promise<Actor> {
    const userId = await this.actor(db, session);
    if (
      !(
        await rows(
          db,
          "SELECT user_id FROM platform_user_roles WHERE user_id=? AND role_code='PLATFORM_ADMIN' FOR SHARE",
          [userId],
        )
      ).length
    )
      throw new ApiError(403, 'ACCESS_DENIED', 'Access is not permitted.');
    return { userId, membershipId: null };
  }
  async setup(db: PoolConnection, societyId: string): Promise<SetupRow> {
    const result = await rows<SetupRow>(
      db,
      'SELECT s.id AS society_id,s.code,s.name,s.timezone,s.status,o.revision,o.residents_confirmed,o.maintenance_confirmed,o.reviewed_revision,o.reviewed_by_membership_id,o.reviewed_at,o.verified_by_membership_id,o.verified_at FROM societies s JOIN society_onboarding o ON o.society_id=s.id WHERE s.id=? AND s.archived_at IS NULL FOR UPDATE',
      [societyId],
    );
    const setup = result[0];
    if (!setup) throw notFound();
    return setup;
  }
  async access(
    db: PoolConnection,
    session: Session,
    societyId: string,
    scope: Scope,
  ): Promise<{ actor: Actor; setup: SetupRow }> {
    const actor: Actor =
      scope === 'platform'
        ? await this.platform(db, session)
        : { userId: await this.actor(db, session), membershipId: null };
    const setup = await this.setup(db, societyId);
    if (scope === 'committee') {
      const members = await rows<RowDataPacket>(
        db,
        `SELECT m.id FROM society_memberships m
    JOIN users u ON u.id=m.user_id AND u.status='ACTIVE'
    LEFT JOIN membership_person_links l ON l.society_id=m.society_id AND l.membership_id=m.id
    JOIN society_persons sp ON sp.society_id=m.society_id AND sp.person_id=COALESCE(l.person_id,u.person_id) AND sp.archived_at IS NULL
    JOIN membership_roles mr ON mr.society_id=m.society_id AND mr.membership_id=m.id
    JOIN roles r ON r.society_id=mr.society_id AND r.id=mr.role_id AND r.code='COMMITTEE_ADMIN' AND r.archived_at IS NULL
    JOIN role_permissions rp ON rp.society_id=r.society_id AND rp.role_id=r.id
    JOIN permissions p ON p.id=rp.permission_id AND p.code='society.members.manage'
    WHERE m.society_id=? AND m.user_id=? AND m.status='ACTIVE' AND m.joined_at<=UTC_TIMESTAMP(6) AND m.ended_at IS NULL FOR SHARE`,
        [societyId, actor.userId],
      );
      const member: unknown = members[0]?.['id'];
      if (typeof member !== 'string') throw notFound();
      actor.membershipId = member;
    }
    return { actor, setup };
  }
  async counts(db: PoolConnection, societyId: string): Promise<CountRow> {
    const result = await rows<CountRow>(
      db,
      `SELECT
   (SELECT COUNT(*) FROM buildings WHERE society_id=? AND archived_at IS NULL) AS buildings,
   (SELECT COUNT(*) FROM flats WHERE society_id=? AND archived_at IS NULL) AS flats,
   (SELECT COUNT(*) FROM flat_occupancies WHERE society_id=?) AS residents,
   (SELECT COUNT(*) FROM maintenance_charge_configurations c JOIN maintenance_charge_types t ON t.society_id=c.society_id AND t.id=c.charge_type_id AND t.archived_at IS NULL WHERE c.society_id=?) AS maintenance,
   (SELECT COUNT(*) FROM buildings b WHERE b.society_id=? AND b.archived_at IS NULL AND NOT EXISTS(SELECT 1 FROM flats f WHERE f.society_id=b.society_id AND f.building_id=b.id AND f.archived_at IS NULL)) AS emptyBuildings,
   (SELECT COUNT(*) FROM flats WHERE society_id=? AND archived_at IS NULL AND area_sq_ft IS NULL) AS missingAreas,
   (SELECT COUNT(*) FROM society_setup_invitations i JOIN users u ON u.id=i.accepted_by_user_id AND u.status='ACTIVE'
     JOIN society_memberships m ON m.society_id=i.society_id AND m.user_id=u.id AND m.status='ACTIVE' AND m.joined_at<=UTC_TIMESTAMP(6) AND m.ended_at IS NULL
     LEFT JOIN membership_person_links l ON l.society_id=m.society_id AND l.membership_id=m.id
     JOIN society_persons sp ON sp.society_id=m.society_id AND sp.person_id=COALESCE(l.person_id,u.person_id) AND sp.archived_at IS NULL
     JOIN membership_roles mr ON mr.society_id=m.society_id AND mr.membership_id=m.id
     JOIN roles r ON r.society_id=mr.society_id AND r.id=mr.role_id AND r.code='COMMITTEE_ADMIN' AND r.archived_at IS NULL
     JOIN role_permissions rp ON rp.society_id=r.society_id AND rp.role_id=r.id JOIN permissions p ON p.id=rp.permission_id AND p.code='society.members.manage'
     WHERE i.society_id=? AND i.status='ACCEPTED') AS committee,
   (SELECT COUNT(*) FROM maintenance_charge_configurations c JOIN maintenance_charge_types t ON t.society_id=c.society_id AND t.id=c.charge_type_id AND t.archived_at IS NULL WHERE c.society_id=? AND c.calculation_method='PER_SQ_FT') AS perArea`,
      Array<string>(8).fill(societyId),
    );
    const value = result[0];
    if (!value) throw notFound();
    return value;
  }
  requirements(setup: SetupRow, c: CountRow): Requirements {
    return {
      committee: Number(c.committee) > 0,
      buildings: Number(c.buildings) > 0 && Number(c.emptyBuildings) === 0,
      flats: Number(c.flats) > 0,
      residents: setup.residents_confirmed === 1,
      maintenance:
        setup.maintenance_confirmed === 1 &&
        Number(c.maintenance) > 0 &&
        (Number(c.perArea) === 0 || Number(c.missingAreas) === 0),
    };
  }
  async advance(db: PoolConnection, setup: SetupRow): Promise<void> {
    await db.execute(
      'UPDATE society_onboarding SET revision=revision+1,reviewed_revision=NULL,reviewed_by_membership_id=NULL,reviewed_at=NULL WHERE society_id=?',
      [setup.society_id],
    );
  }
  async event(
    db: PoolConnection,
    setup: SetupRow,
    actor: Actor,
    action: string,
    audit: RequestAudit,
    from: SocietyStatus | null = setup.status,
  ): Promise<void> {
    await db.execute(
      'INSERT INTO society_onboarding_events(society_id,actor_user_id,action,from_status,to_status,revision,request_id,created_at) SELECT society_id,?,?,?, ?,revision,?,? FROM society_onboarding WHERE society_id=?',
      [
        actor.userId,
        action,
        from,
        setup.status,
        audit.requestId,
        sqlTime(this.clock()),
        setup.society_id,
      ],
    );
    await db.execute(
      "INSERT INTO audit_logs(society_id,actor_user_id,action,entity_type,entity_id,request_id,safe_metadata,created_at) VALUES(?,?,?,'society',?,?,?,?)",
      [
        setup.society_id,
        actor.userId,
        action,
        setup.society_id,
        audit.requestId,
        JSON.stringify({ fromStatus: from, toStatus: setup.status }),
        sqlTime(this.clock()),
      ],
    );
  }
  async list(session: Session, page: PageInput) {
    return this.database.transaction(async (db) => {
      await this.platform(db, session);
      const where = page.status ? 's.archived_at IS NULL AND s.status=?' : 's.archived_at IS NULL';
      const values: Values = page.status ? [page.status] : [];
      const total = await rows(
        db,
        'SELECT COUNT(*) AS total FROM societies s WHERE ' + where,
        values,
      );
      const items = await rows(
        db,
        'SELECT s.id,s.code,s.name,s.timezone,s.status,o.revision,o.verified_at AS verifiedAt FROM societies s LEFT JOIN society_onboarding o ON o.society_id=s.id WHERE ' +
          where +
          ' ORDER BY s.id DESC LIMIT ? OFFSET ?',
        [...values, page.pageSize, (page.page - 1) * page.pageSize],
      );
      return {
        items: items.map((row) => ({ ...row, verifiedAt: utcTimestamp(row['verifiedAt']) })),
        total: Number(total[0]?.['total']),
        page: page.page,
        pageSize: page.pageSize,
      };
    });
  }
  async dashboard(session: Session) {
    return this.database.transaction(async (db) => {
      await this.platform(db, session);
      const counts = await rows<RowDataPacket & { status: SocietyStatus; total: string | number }>(
        db,
        'SELECT status,COUNT(*) AS total FROM societies WHERE archived_at IS NULL GROUP BY status',
      );
      return {
        statuses: counts.map((row) => ({ status: row['status'], total: Number(row['total']) })),
        totalSocieties: counts.reduce((sum, row) => sum + Number(row.total), 0),
        pendingVerification: Number(
          counts.find((row) => row.status === 'PENDING_VERIFICATION')?.total ?? 0,
        ),
        updatedAt: new Date(this.clock()).toISOString(),
      };
    });
  }
}
