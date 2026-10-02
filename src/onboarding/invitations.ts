import type { RowDataPacket, PoolConnection } from 'mysql2/promise';
import { ApiError } from '../http/errors.js';
import { newToken, tokenHash, hashPassword } from '../auth/crypto.js';
import { sqlTime } from '../auth/repository.js';
import type { Session, RequestAudit } from '../auth/types.js';
import type { ResetQueue } from '../auth/reset-queue.js';
import type { OnboardingService } from './service.js';
import { insert, rows, utcTimestamp } from './repository.js';
import { assertEditable } from './policy.js';
export interface InvitationMailer {
  send(email: string, link: string, societyName: string): Promise<void>;
}
interface InvitationRow extends RowDataPacket {
  id: string;
  society_id: string;
  email_normalized: string;
  display_name: string;
  token_hash: Buffer;
  status: string;
  expires_at: string;
  name: string;
}
interface UserData {
  id: string;
  person_id: string;
  email_normalized: string;
  status: string;
  password_hash: string | null;
}
interface UserRow extends RowDataPacket, UserData {}
const invalid = () =>
  new ApiError(400, 'INVITATION_INVALID', 'This invitation is unavailable or expired.');
export class InvitationService {
  constructor(
    readonly onboarding: OnboardingService,
    readonly origin: string,
    readonly mailer: InvitationMailer,
    readonly queue: ResetQueue,
  ) {}
  async invite(
    session: Session,
    id: string,
    revision: string,
    email: string,
    displayName: string,
    audit: RequestAudit,
  ): Promise<void> {
    const token = newToken();
    let invitationId = '';
    let name = '';
    await this.onboarding.change(session, id, 'platform', revision, async (db, setup, actor) => {
      assertEditable(setup.status);
      name = setup.name;
      if (
        (
          await rows(
            db,
            "SELECT id FROM society_setup_invitations WHERE society_id=? AND status='ACCEPTED' LIMIT 1",
            [id],
          )
        ).length
      )
        throw new ApiError(
          409,
          'COMMITTEE_ALREADY_ASSIGNED',
          'The initial committee administrator is already assigned.',
        );
      await db.execute(
        "UPDATE society_setup_invitations SET status=CASE WHEN expires_at<=? THEN 'EXPIRED' ELSE 'REVOKED' END WHERE society_id=? AND status='PENDING'",
        [sqlTime(this.onboarding.repository.clock()), id],
      );
      invitationId = await insert(
        db,
        'INSERT INTO society_setup_invitations(society_id,email_normalized,display_name,token_hash,expires_at,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?)',
        [
          id,
          email,
          displayName,
          tokenHash(token),
          sqlTime(this.onboarding.repository.clock() + 72 * 3600000),
          actor.userId,
          sqlTime(this.onboarding.repository.clock()),
        ],
      );
      await this.onboarding.repository.advance(db, setup);
      await this.onboarding.repository.event(db, setup, actor, 'committee.invited', audit);
    });
    const queued = this.queue.enqueue(async () => {
      try {
        await this.mailer.send(email, this.origin + '/accept-invitation#token=' + token, name);
        await this.delivery(id, invitationId, 'SENT');
      } catch {
        await this.delivery(id, invitationId, 'FAILED');
        throw new Error('Invitation delivery failed.');
      }
    }, audit.requestId);
    if (!queued) await this.delivery(id, invitationId, 'FAILED');
  }
  private async delivery(id: string, invitation: string, status: string): Promise<void> {
    await this.onboarding.repository.database.connection(async (db) => {
      await db.execute(
        'UPDATE society_setup_invitations SET delivery_status=? WHERE society_id=? AND id=?',
        [status, id, invitation],
      );
    });
  }
  private async lookup(db: PoolConnection, token: string, lock = false): Promise<InvitationRow> {
    const result = await rows<InvitationRow>(
      db,
      "SELECT i.id,i.society_id,i.email_normalized,i.display_name,i.token_hash,i.status,i.expires_at,s.name FROM society_setup_invitations i JOIN societies s ON s.id=i.society_id WHERE i.token_hash=? AND i.status='PENDING' AND i.expires_at>? AND s.status='SETUP_IN_PROGRESS' AND s.archived_at IS NULL" +
        (lock ? ' FOR UPDATE' : ''),
      [tokenHash(token), sqlTime(this.onboarding.repository.clock())],
    );
    const row = result[0];
    if (!row) throw invalid();
    return row;
  }
  async inspect(token: string) {
    return this.onboarding.repository.database.connection(async (db) => {
      const row = await this.lookup(db, token);
      const user = await rows(db, 'SELECT id FROM users WHERE email_normalized=?', [
        row.email_normalized,
      ]);
      return {
        societyName: row.name,
        email: row.email_normalized,
        displayName: row.display_name,
        expiresAt: utcTimestamp(row.expires_at),
        requiresLogin: user.length > 0,
      };
    });
  }
  async accept(
    session: Session | null,
    token: string,
    password: string | undefined,
    audit: RequestAudit,
  ): Promise<void> {
    const repository = this.onboarding.repository;
    // Compute Argon2 before taking SQL locks, after proving the token is usable.
    const preview = await this.inspect(token);
    const encoded = !preview.requiresLogin && password ? await hashPassword(password) : null;
    await repository.database.transaction(async (db) => {
      const current = await this.lookup(db, token);
      let actorId: string | null = null;
      if (session?.userId) actorId = await repository.actor(db, session);
      const users = await rows<UserRow>(
        db,
        'SELECT id,person_id,email_normalized,status,password_hash FROM users WHERE email_normalized=? FOR UPDATE',
        [current.email_normalized],
      );
      let user: UserData | undefined = users[0];
      if (user) {
        if (
          user.status !== 'ACTIVE' ||
          !user.password_hash ||
          actorId !== user.id ||
          password !== undefined
        )
          throw new ApiError(
            403,
            'INVITATION_LOGIN_REQUIRED',
            'Sign in with the invited account, then reopen this invitation.',
          );
      } else if (!encoded || actorId) throw invalid();
      const setup = await repository.setup(db, current.society_id);
      assertEditable(setup.status);
      const invitation = await this.lookup(db, token, true);
      if (!user) {
        const personId = await insert(db, 'INSERT INTO persons() VALUES()');
        const userId = await insert(
          db,
          "INSERT INTO users(person_id,email_normalized,password_hash,status,email_verified_at) VALUES(?,?,?,'ACTIVE',?)",
          [personId, invitation.email_normalized, encoded, sqlTime(repository.clock())],
        );
        user = {
          id: userId,
          person_id: personId,
          email_normalized: invitation.email_normalized,
          status: 'ACTIVE',
          password_hash: encoded,
        };
      }
      const existing = await rows(
        db,
        'SELECT id FROM society_memberships WHERE society_id=? AND user_id=?',
        [invitation.society_id, user.id],
      );
      if (existing.length) throw invalid();
      const profiles = await rows(
        db,
        'SELECT id,archived_at FROM society_persons WHERE society_id=? AND person_id=?',
        [invitation.society_id, user.person_id],
      );
      if (profiles.length) throw invalid();
      await db.execute(
        'INSERT INTO society_persons(society_id,person_id,display_name) VALUES(?,?,?)',
        [invitation.society_id, user.person_id, invitation.display_name],
      );
      const membership = await insert(
        db,
        "INSERT INTO society_memberships(society_id,user_id,status,joined_at) VALUES(?,?,'ACTIVE',?)",
        [invitation.society_id, user.id, sqlTime(repository.clock())],
      );
      const role = await rows(
        db,
        "SELECT id FROM roles WHERE society_id=? AND code='COMMITTEE_ADMIN' AND archived_at IS NULL",
        [invitation.society_id],
      );
      const roleId: unknown = role[0]?.['id'];
      if (typeof roleId !== 'string') throw invalid();
      await db.execute(
        'INSERT INTO membership_roles(society_id,membership_id,role_id) VALUES(?,?,?)',
        [invitation.society_id, membership, roleId],
      );
      await db.execute(
        "UPDATE society_setup_invitations SET status='ACCEPTED',accepted_at=?,accepted_by_user_id=? WHERE society_id=? AND id=?",
        [sqlTime(repository.clock()), user.id, invitation.society_id, invitation.id],
      );
      await repository.advance(db, setup);
      await repository.event(
        db,
        setup,
        { userId: user.id, membershipId: membership },
        'committee.accepted',
        audit,
      );
    });
  }
}
