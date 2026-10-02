import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { RequestAudit, Session } from '../auth/types.js';
import { sqlTime } from '../auth/repository.js';
import { newToken, tokenHash, hashPassword } from '../auth/crypto.js';
import { rows, insert, utcTimestamp, notFound } from '../onboarding/repository.js';
import { assertUnarchived } from '../property/models.js';
import type { TenantScope } from '../property/access.js';
import type { ResidentAccounts } from './accounts.js';
import { unavailable, conflict } from './identity.js';
import type { ResidentIdentity, ResidentUser, ResidentUserData } from './identity.js';
import { email, type PageInput } from './contracts.js';
interface InviteRow extends RowDataPacket {
  id: string;
  society_id: string;
  person_id: string;
  flat_id: string;
  email_normalized: string;
  display_name: string;
  name: string;
  expires_at: string;
  status: string;
  delivery_status: string;
}
const select =
  "SELECT i.id,i.society_id,i.person_id,i.flat_id,i.email_normalized,i.expires_at,i.status,d.delivery_status,p.display_name,s.name FROM invitations i JOIN resident_invitation_details d ON d.society_id=i.society_id AND d.invitation_id=i.id AND d.intended_action='RESIDENT_JOIN' JOIN roles r ON r.society_id=i.society_id AND r.id=i.role_id AND r.code='RESIDENT' JOIN society_persons p ON p.society_id=i.society_id AND p.person_id=i.person_id JOIN societies s ON s.id=i.society_id";
export class ResidentInvitations {
  constructor(
    readonly identity: ResidentIdentity,
    readonly accounts: ResidentAccounts,
  ) {}
  private async eligibility(
    db: PoolConnection,
    scope: TenantScope,
    personId: string,
    flatId: string,
  ): Promise<string> {
    const p = await this.identity.property.personRow(db, scope, personId);
    assertUnarchived(p);
    const parsed = email.safeParse(p.contactEmail);
    if (!parsed.success) throw conflict();
    const flat = await this.identity.property.flatRow(db, scope, flatId);
    assertUnarchived(flat);
    assertUnarchived(await this.identity.property.buildingRow(db, scope, flat.buildingId));
    if (
      !(
        await rows(
          db,
          'SELECT id FROM flat_occupancies WHERE society_id=? AND flat_id=? AND person_id=? AND starts_on<=? AND (ends_on IS NULL OR ends_on>=?) LIMIT 1',
          [scope.societyId, flatId, personId, scope.today, scope.today],
        )
      ).length
    )
      throw conflict();
    return parsed.data;
  }
  private async create(
    db: PoolConnection,
    scope: TenantScope,
    personId: string,
    flatId: string,
    audit: RequestAudit,
  ) {
    const address = await this.eligibility(db, scope, personId, flatId),
      token = newToken(),
      now = this.identity.property.access.clock();
    await db.execute(
      "UPDATE invitations SET status='EXPIRED' WHERE society_id=? AND status='PENDING' AND expires_at<=?",
      [scope.societyId, sqlTime(now)],
    );
    const role = (
      await rows<RowDataPacket & { id: string }>(
        db,
        "SELECT id FROM roles WHERE society_id=? AND code='RESIDENT' AND archived_at IS NULL",
        [scope.societyId],
      )
    )[0];
    if (!role) throw conflict();
    const id = await insert(
      db,
      'INSERT INTO invitations(society_id,person_id,flat_id,role_id,email_normalized,token_hash,expires_at,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      [
        scope.societyId,
        personId,
        flatId,
        role.id,
        address,
        tokenHash(token),
        sqlTime(now + 72 * 3600000),
        scope.userId,
        sqlTime(now),
      ],
    );
    await db.execute(
      'INSERT INTO resident_invitation_details(society_id,invitation_id) VALUES(?,?)',
      [scope.societyId, id],
    );
    await this.identity.property.access.audit(
      db,
      scope,
      'resident.invited',
      'invitation',
      id,
      audit,
    );
    const society = (
      await rows<RowDataPacket & { name: string }>(db, 'SELECT name FROM societies WHERE id=?', [
        scope.societyId,
      ])
    )[0];
    if (!society) throw conflict();
    return { id, token, address, name: society.name, societyId: scope.societyId };
  }
  private async send(
    invite: { id: string; token: string; address: string; name: string; societyId: string },
    audit: RequestAudit,
  ) {
    const delivery = async (status: string) =>
      this.identity.property.access.database.connection(async (db) => {
        await db.execute(
          'UPDATE resident_invitation_details SET delivery_status=? WHERE society_id=? AND invitation_id=?',
          [status, invite.societyId, invite.id],
        );
      });
    const queued = this.accounts.queue.enqueue(async () => {
      try {
        await this.accounts.mailer.invitation(
          invite.address,
          this.accounts.origin + '/resident-invitation#token=' + invite.token,
          invite.name,
        );
        await delivery('SENT');
      } catch {
        await delivery('FAILED');
        throw new Error('Resident invitation delivery failed.');
      }
    }, audit.requestId);
    if (!queued) await delivery('FAILED');
  }
  async invite(session: Session, personId: string, flatId: string, audit: RequestAudit) {
    const result = await this.identity.property.within(session, true, async (db, scope) =>
      this.create(db, scope, personId, flatId, audit),
    );
    await this.send(result, audit);
    return { id: result.id };
  }
  async resend(session: Session, id: string, audit: RequestAudit, note: string) {
    const result = await this.identity.property.within(session, true, async (db, scope) => {
      const old = (
        await rows<InviteRow>(db, select + ' WHERE i.society_id=? AND i.id=? FOR SHARE', [
          scope.societyId,
          id,
        ])
      )[0];
      if (!old) throw notFound();
      if (old.status === 'ACCEPTED') throw conflict();
      if (old.status === 'PENDING') {
        await db.execute(
          "UPDATE invitations SET status=CASE WHEN expires_at<=? THEN 'EXPIRED' ELSE 'REVOKED' END WHERE society_id=? AND id=?",
          [sqlTime(this.identity.property.access.clock()), scope.societyId, id],
        );
      }
      await this.identity.property.access.audit(
        db,
        scope,
        'resident.invitation_resent',
        'invitation',
        id,
        audit,
        { note },
      );
      return this.create(db, scope, old.person_id, old.flat_id, audit);
    });
    await this.send(result, audit);
    return { id: result.id };
  }
  async revoke(session: Session, id: string, audit: RequestAudit, note: string) {
    await this.identity.property.within(session, true, async (db, scope) => {
      const row = (
        await rows<InviteRow>(db, select + ' WHERE i.society_id=? AND i.id=? FOR SHARE', [
          scope.societyId,
          id,
        ])
      )[0];
      if (!row) throw notFound();
      if (row.status !== 'PENDING') throw conflict();
      await db.execute(
        "UPDATE invitations SET status=CASE WHEN expires_at<=? THEN 'EXPIRED' ELSE 'REVOKED' END WHERE society_id=? AND id=?",
        [sqlTime(this.identity.property.access.clock()), scope.societyId, id],
      );
      await this.identity.property.access.audit(
        db,
        scope,
        'resident.invitation_revoked',
        'invitation',
        id,
        audit,
        { note },
      );
    });
  }
  async list(session: Session, page: PageInput) {
    return this.identity.property.within(session, false, async (db, scope) => {
      const effective =
        "CASE WHEN i.status='PENDING' AND i.expires_at<=? THEN 'EXPIRED' ELSE i.status END";
      const where =
        ' WHERE i.society_id=?' + (page.status === 'all' ? '' : ' AND ' + effective + '=?');
      const values =
        page.status === 'all'
          ? [scope.societyId]
          : [scope.societyId, sqlTime(this.identity.property.access.clock()), page.status];
      const total =
        (
          await rows<RowDataPacket & { total: number }>(
            db,
            'SELECT COUNT(*) AS total FROM invitations i JOIN resident_invitation_details d ON d.society_id=i.society_id AND d.invitation_id=i.id' +
              where,
            values,
          )
        )[0]?.total ?? 0;
      const data = await rows<InviteRow>(
        db,
        select + where + ' ORDER BY i.id DESC LIMIT 20 OFFSET ?',
        [...values, (page.page - 1) * 20],
      );
      return {
        items: data.map((r) => ({
          id: r.id,
          personId: r.person_id,
          flatId: r.flat_id,
          displayName: r.display_name,
          email: r.email_normalized,
          status:
            r.status === 'PENDING' && r.expires_at <= sqlTime(this.identity.property.access.clock())
              ? 'EXPIRED'
              : r.status,
          deliveryStatus: r.delivery_status,
          expiresAt: utcTimestamp(r.expires_at),
        })),
        total: Number(total),
        page: page.page,
        pageSize: 20,
      };
    });
  }
  async expire(): Promise<void> {
    await this.identity.property.access.database.connection(async (db) => {
      await db.execute(
        "UPDATE invitations i SET status='EXPIRED' WHERE i.status='PENDING' AND i.expires_at<=? AND EXISTS(SELECT 1 FROM resident_invitation_details d WHERE d.society_id=i.society_id AND d.invitation_id=i.id) LIMIT 1000",
        [sqlTime(this.identity.property.access.clock())],
      );
    });
  }
  private async lookup(db: PoolConnection, token: string, lock = false): Promise<InviteRow> {
    if (lock)
      await rows(db, 'SELECT id FROM invitations WHERE token_hash=? FOR UPDATE', [
        tokenHash(token),
      ]);
    const i = (
      await rows<InviteRow>(
        db,
        select +
          " WHERE i.token_hash=? AND i.status='PENDING' AND i.expires_at>? AND s.status='ACTIVE' AND s.archived_at IS NULL AND p.archived_at IS NULL AND r.archived_at IS NULL",
        [tokenHash(token), sqlTime(this.identity.property.access.clock())],
      )
    )[0];
    if (!i) throw unavailable();
    return i;
  }
  async inspect(token: string) {
    return this.identity.property.access.database.connection(async (db) => {
      const i = await this.lookup(db, token);
      return {
        societyName: i.name,
        displayName: i.display_name,
        email: i.email_normalized,
        expiresAt: utcTimestamp(i.expires_at),
        action: 'RESIDENT_JOIN',
      };
    });
  }
  async accept(
    session: Session | null,
    token: string,
    password: string | undefined,
    audit: RequestAudit,
  ): Promise<void> {
    await this.inspect(token);
    const encoded = password ? await hashPassword(password) : null;
    await this.identity.property.access.database.transaction(async (db) => {
      const actor = session?.userId ? await this.identity.actor(db, session) : null;
      const preview = await this.lookup(db, token);
      const society = await this.identity.activeSociety(db, preview.society_id);
      const i = await this.lookup(db, token, true);
      const scope: TenantScope = {
        societyId: i.society_id,
        userId: actor?.id ?? '',
        membershipId: '',
        today: society.today,
        timezone: 'UTC',
      };
      // Recheck email, profile, flat and current occupancy at acceptance time.
      if ((await this.eligibility(db, scope, i.person_id, i.flat_id)) !== i.email_normalized)
        throw unavailable();
      let user: ResidentUserData | undefined = (
        await rows<ResidentUser>(
          db,
          'SELECT id,person_id,email_normalized,status,password_hash FROM users WHERE email_normalized=? FOR UPDATE',
          [i.email_normalized],
        )
      )[0];
      if (user) {
        if (!actor || actor.id !== user.id || user.status !== 'ACTIVE' || password !== undefined)
          throw unavailable();
      } else {
        if (
          actor ||
          !encoded ||
          (await rows(db, 'SELECT id FROM users WHERE person_id=? FOR UPDATE', [i.person_id]))
            .length
        )
          throw unavailable();
        const id = await insert(
          db,
          "INSERT INTO users(person_id,email_normalized,password_hash,status,email_verified_at) VALUES(?,?,?,'ACTIVE',?)",
          [
            i.person_id,
            i.email_normalized,
            encoded,
            sqlTime(this.identity.property.access.clock()),
          ],
        );
        user = {
          id,
          person_id: i.person_id,
          email_normalized: i.email_normalized,
          status: 'ACTIVE',
          password_hash: encoded,
        };
      }
      const membership = await this.identity.member(db, i.society_id, user, i.person_id);
      await db.execute(
        'UPDATE resident_invitation_details SET accepted_membership_id=? WHERE society_id=? AND invitation_id=?',
        [membership, i.society_id, i.id],
      );
      await db.execute(
        "UPDATE invitations SET status='ACCEPTED',accepted_at=?,accepted_by_user_id=? WHERE society_id=? AND id=?",
        [sqlTime(this.identity.property.access.clock()), user.id, i.society_id, i.id],
      );
      await this.identity.property.access.audit(
        db,
        { ...scope, userId: user.id, membershipId: membership },
        'resident.invitation_accepted',
        'invitation',
        i.id,
        audit,
        { personId: i.person_id, membershipId: membership },
      );
    });
  }
}
