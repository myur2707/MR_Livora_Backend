import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { Session } from '../auth/types.js';
import { sqlTime } from '../auth/repository.js';
import { ApiError } from '../http/errors.js';
import { insert, rows, OnboardingRepository } from '../onboarding/repository.js';
import type { PropertyService } from '../property/service.js';
export interface ResidentUserData {
  id: string;
  person_id: string;
  email_normalized: string;
  status: string;
  password_hash: string | null;
}
export interface ResidentUser extends RowDataPacket, ResidentUserData {}
export const unavailable = () =>
  new ApiError(
    400,
    'RESIDENT_LINK_INVALID',
    'This link is unavailable or expired. Sign in with the intended email if you already have an account.',
  );
export const conflict = () =>
  new ApiError(
    409,
    'RESIDENT_ACCESS_CONFLICT',
    'This person or account is already linked, or the request changed. Refresh and review the records.',
  );
export const homeAlreadyLinked = () =>
  new ApiError(
    409,
    'RESIDENT_HOME_ALREADY_LINKED',
    'You already have access to this home. Choose a different flat or row house.',
  );
export const requestPending = () =>
  new ApiError(
    409,
    'RESIDENT_REQUEST_PENDING',
    'You already have a pending request in this community. Wait for the committee or cancel it first.',
  );
export class ResidentIdentity {
  private readonly sessions: OnboardingRepository;
  constructor(readonly property: PropertyService) {
    this.sessions = new OnboardingRepository(property.access.database, property.access.clock);
  }
  async actor(db: PoolConnection, session: Session): Promise<ResidentUser> {
    const id = await this.sessions.actor(db, session);
    const user = (
      await rows<ResidentUser>(
        db,
        "SELECT id,person_id,email_normalized,status,password_hash FROM users WHERE id=? AND status='ACTIVE' FOR UPDATE",
        [id],
      )
    )[0];
    if (!user) throw unavailable();
    return user;
  }
  async activeSociety(
    db: PoolConnection,
    societyId: string,
  ): Promise<{ name: string; today: string }> {
    const s = (
      await rows<RowDataPacket & { name: string; timezone: string }>(
        db,
        "SELECT name,timezone FROM societies WHERE id=? AND status='ACTIVE' AND archived_at IS NULL FOR UPDATE",
        [societyId],
      )
    )[0];
    if (!s) throw unavailable();
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: s.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(this.property.access.clock()));
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return { name: s.name, today: part('year') + '-' + part('month') + '-' + part('day') };
  }
  /** The account's membership in a society and the person it is linked to, if any. */
  async membership(
    db: PoolConnection,
    societyId: string,
    userId: string,
  ): Promise<{ id: string; status: string; personId: string } | undefined> {
    return (
      await rows<RowDataPacket & { id: string; status: string; personId: string }>(
        db,
        'SELECT m.id,m.status,COALESCE(l.person_id,u.person_id) AS personId FROM society_memberships m JOIN users u ON u.id=m.user_id LEFT JOIN membership_person_links l ON l.society_id=m.society_id AND l.membership_id=m.id WHERE m.society_id=? AND m.user_id=? FOR SHARE',
        [societyId, userId],
      )
    )[0];
  }
  /** Gives an existing member the resident role when they are approved for another home. */
  async ensureResidentRole(
    db: PoolConnection,
    societyId: string,
    membershipId: string,
  ): Promise<void> {
    const role = (
      await rows<RowDataPacket & { id: string }>(
        db,
        "SELECT id FROM roles WHERE society_id=? AND code='RESIDENT' AND archived_at IS NULL",
        [societyId],
      )
    )[0];
    if (!role) throw conflict();
    const assigned = await rows(
      db,
      'SELECT 1 FROM membership_roles WHERE society_id=? AND membership_id=? AND role_id=? FOR SHARE',
      [societyId, membershipId, role.id],
    );
    if (!assigned.length)
      await db.execute(
        'INSERT INTO membership_roles(society_id,membership_id,role_id) VALUES(?,?,?)',
        [societyId, membershipId, role.id],
      );
  }
  /**
   * Resident membership for an approved home: reuses the account's existing active membership in
   * the society (a second home) when it belongs to the same person, otherwise creates one.
   */
  async residentMembership(
    db: PoolConnection,
    societyId: string,
    user: ResidentUserData,
    personId: string,
  ): Promise<string> {
    const existing = await this.membership(db, societyId, user.id);
    if (!existing) return this.member(db, societyId, user, personId);
    if (existing.status !== 'ACTIVE' || existing.personId !== personId) throw conflict();
    await this.ensureResidentRole(db, societyId, existing.id);
    return existing.id;
  }
  async member(
    db: PoolConnection,
    societyId: string,
    user: ResidentUserData,
    personId: string,
  ): Promise<string> {
    // Every caller holds the society write lock; unique keys also protect creation.
    const existing = await rows(
      db,
      'SELECT id FROM society_memberships WHERE society_id=? AND user_id=? FOR SHARE',
      [societyId, user.id],
    );
    const bound = await rows(
      db,
      'SELECT m.id FROM society_memberships m JOIN users u ON u.id=m.user_id LEFT JOIN membership_person_links l ON l.society_id=m.society_id AND l.membership_id=m.id WHERE m.society_id=? AND COALESCE(l.person_id,u.person_id)=? FOR SHARE',
      [societyId, personId],
    );
    const owner = await rows<RowDataPacket & { id: string }>(
      db,
      'SELECT id FROM users WHERE person_id=? FOR UPDATE',
      [personId],
    );
    if (existing.length || bound.length || owner.some((u) => u.id !== user.id)) throw conflict();
    const role = (
      await rows<RowDataPacket & { id: string }>(
        db,
        "SELECT id FROM roles WHERE society_id=? AND code='RESIDENT' AND archived_at IS NULL",
        [societyId],
      )
    )[0];
    if (!role) throw conflict();
    const id = await insert(
      db,
      "INSERT INTO society_memberships(society_id,user_id,status,joined_at) VALUES(?,?,'ACTIVE',?)",
      [societyId, user.id, sqlTime(this.property.access.clock())],
    );
    await db.execute(
      'INSERT INTO membership_person_links(society_id,membership_id,person_id) VALUES(?,?,?)',
      [societyId, id, personId],
    );
    await db.execute(
      'INSERT INTO membership_roles(society_id,membership_id,role_id) VALUES(?,?,?)',
      [societyId, id, role.id],
    );
    return id;
  }
}
