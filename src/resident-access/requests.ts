import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { Session, RequestAudit } from '../auth/types.js';
import { sqlTime } from '../auth/repository.js';
import { rows, insert, notFound, utcTimestamp } from '../onboarding/repository.js';
import { assertUnarchived } from '../property/models.js';
import type { OccupancyService } from '../property/occupancies.js';
import type { TenantScope } from '../property/access.js';
import { conflict, unavailable } from './identity.js';
import type { ResidentIdentity, ResidentUser } from './identity.js';
import type { JoinInput, ApprovalInput, PageInput } from './contracts.js';
interface RequestRow extends RowDataPacket {
  id: string;
  society_id: string;
  user_id: string;
  requested_flat_id: string;
  requested_occupancy_type: string;
  status: string;
  display_name: string;
  contact_phone: string | null;
  email: string;
  applicant_note: string | null;
  reviewedAt: string | null;
  decisionNote: string | null;
  societyName: string;
  buildingCode: string;
  flatNumber: string;
  resolvedPersonId: string | null;
  membershipId: string | null;
  occupancyId: string | null;
}
const select =
  'SELECT r.id,r.society_id,r.user_id,r.requested_flat_id,r.requested_occupancy_type,r.status,r.reviewed_at AS reviewedAt,r.decision_note AS decisionNote,d.display_name,d.contact_phone,d.applicant_note,d.resolved_person_id AS resolvedPersonId,d.approved_membership_id AS membershipId,d.approved_occupancy_id AS occupancyId,u.email_normalized AS email,s.name AS societyName,b.code AS buildingCode,f.flat_number AS flatNumber FROM registration_requests r JOIN registration_request_details d ON d.society_id=r.society_id AND d.request_id=r.id JOIN users u ON u.id=r.user_id JOIN societies s ON s.id=r.society_id JOIN flats f ON f.society_id=r.society_id AND f.id=r.requested_flat_id JOIN buildings b ON b.society_id=f.society_id AND b.id=f.building_id';
export class ResidentRequests {
  constructor(
    readonly identity: ResidentIdentity,
    readonly occupancy: OccupancyService,
  ) {}
  async join(session: Session, input: JoinInput, audit: RequestAudit) {
    return this.identity.property.access.database.transaction(async (db) => {
      const user = await this.identity.actor(db, session);
      const target = (
        await rows<RowDataPacket & { society_id: string; flat_id: string }>(
          db,
          "SELECT s.id AS society_id,f.id AS flat_id FROM societies s JOIN buildings b ON b.society_id=s.id JOIN flats f ON f.society_id=b.society_id AND f.building_id=b.id WHERE s.code=? AND b.code=? AND f.flat_number=? AND s.status='ACTIVE' AND s.archived_at IS NULL AND b.archived_at IS NULL AND f.archived_at IS NULL",
          [input.societyCode, input.buildingCode, input.flatNumber],
        )
      )[0];
      if (!target) throw unavailable();
      await this.identity.activeSociety(db, target.society_id);
      if (
        (
          await rows(db, 'SELECT id FROM society_memberships WHERE society_id=? AND user_id=?', [
            target.society_id,
            user.id,
          ])
        ).length
      )
        throw conflict();
      const id = await insert(
        db,
        'INSERT INTO registration_requests(society_id,user_id,requested_flat_id,requested_occupancy_type) VALUES(?,?,?,?)',
        [target.society_id, user.id, target.flat_id, input.occupancyType],
      );
      await db.execute(
        'INSERT INTO registration_request_details(society_id,request_id,display_name,contact_phone,applicant_note) VALUES(?,?,?,?,?)',
        [target.society_id, id, input.displayName, input.contactPhone, input.note],
      );
      await this.identity.property.access.audit(
        db,
        {
          societyId: target.society_id,
          userId: user.id,
          membershipId: '',
          today: '',
          timezone: 'UTC',
        },
        'resident.registration_requested',
        'registration_request',
        id,
        audit,
      );
      return { id, status: 'PENDING' };
    });
  }
  private async list(
    db: PoolConnection,
    where: string,
    values: (string | number)[],
    page: PageInput,
  ) {
    if (page.status !== 'all') {
      where += ' AND r.status=?';
      values.push(page.status);
    }
    const total =
      (
        await rows<RowDataPacket & { total: number }>(
          db,
          'SELECT COUNT(*) AS total FROM registration_requests r JOIN registration_request_details d ON d.society_id=r.society_id AND d.request_id=r.id WHERE ' +
            where,
          values,
        )
      )[0]?.total ?? 0;
    const data = await rows<RequestRow>(
      db,
      select + ' WHERE ' + where + ' ORDER BY r.id DESC LIMIT 20 OFFSET ?',
      [...values, (page.page - 1) * 20],
    );
    return {
      items: data.map((r) => ({
        id: r.id,
        societyName: r.societyName,
        displayName: r.display_name,
        email: r.email,
        contactPhone: r.contact_phone,
        note: r.applicant_note,
        flatId: r.requested_flat_id,
        buildingCode: r.buildingCode,
        flatNumber: r.flatNumber,
        occupancyType: r.requested_occupancy_type,
        status: r.status,
        decisionNote: r.decisionNote,
        reviewedAt: utcTimestamp(r.reviewedAt),
        resolvedPersonId: r.resolvedPersonId,
        membershipId: r.membershipId,
        occupancyId: r.occupancyId,
      })),
      total: Number(total),
      page: page.page,
      pageSize: 20,
    };
  }
  async own(session: Session, page: PageInput) {
    return this.identity.property.access.database.transaction(async (db) => {
      const user = await this.identity.actor(db, session);
      return this.list(db, 'r.user_id=?', [user.id], page);
    });
  }
  async pending(session: Session, page: PageInput) {
    return this.identity.property.within(session, false, async (db, scope) => ({
      ...(await this.list(db, 'r.society_id=?', [scope.societyId], page)),
      today: scope.today,
    }));
  }
  private async request(db: PoolConnection, scope: TenantScope, id: string): Promise<RequestRow> {
    const r = (
      await rows<RequestRow>(db, select + ' WHERE r.society_id=? AND r.id=? FOR UPDATE', [
        scope.societyId,
        id,
      ])
    )[0];
    if (!r) throw notFound();
    if (r.status !== 'PENDING') throw conflict();
    return r;
  }
  async cancel(session: Session, id: string, audit: RequestAudit) {
    await this.identity.property.access.database.transaction(async (db) => {
      const user = await this.identity.actor(db, session);
      const r = (
        await rows<RowDataPacket & { society_id: string; status: string }>(
          db,
          'SELECT society_id,status FROM registration_requests WHERE id=? AND user_id=? FOR UPDATE',
          [id, user.id],
        )
      )[0];
      if (!r) throw notFound();
      if (r.status !== 'PENDING') throw conflict();
      await db.execute(
        "UPDATE registration_requests SET status='CANCELLED' WHERE id=? AND user_id=?",
        [id, user.id],
      );
      await this.identity.property.access.audit(
        db,
        { societyId: r.society_id, userId: user.id, membershipId: '', timezone: 'UTC', today: '' },
        'resident.registration_cancelled',
        'registration_request',
        id,
        audit,
      );
    });
  }
  async reject(session: Session, id: string, note: string, audit: RequestAudit) {
    await this.identity.property.within(session, true, async (db, scope) => {
      await this.request(db, scope, id);
      await db.execute(
        "UPDATE registration_requests SET status='REJECTED',reviewed_at=?,reviewed_by_membership_id=?,decision_note=? WHERE society_id=? AND id=?",
        [
          sqlTime(this.identity.property.access.clock()),
          scope.membershipId,
          note,
          scope.societyId,
          id,
        ],
      );
      await this.identity.property.access.audit(
        db,
        scope,
        'resident.registration_rejected',
        'registration_request',
        id,
        audit,
      );
    });
  }
  async approve(session: Session, id: string, input: ApprovalInput, audit: RequestAudit) {
    await this.identity.property.within(session, true, async (db, scope) => {
      const request = await this.request(db, scope, id);
      const user = (
        await rows<ResidentUser>(
          db,
          "SELECT id,person_id,email_normalized,status,password_hash FROM users WHERE id=? AND status='ACTIVE' FOR UPDATE",
          [request.user_id],
        )
      )[0];
      if (!user) throw conflict();
      let personId = input.personId;
      if (personId) {
        assertUnarchived(await this.identity.property.personRow(db, scope, personId));
      } else {
        personId = user.person_id;
        const profile = await rows<RowDataPacket & { archived_at: string | null }>(
          db,
          'SELECT archived_at FROM society_persons WHERE society_id=? AND person_id=?',
          [scope.societyId, personId],
        );
        if (profile[0]?.archived_at) throw conflict();
        if (!profile.length)
          await db.execute(
            'INSERT INTO society_persons(society_id,person_id,display_name,contact_email,contact_phone) VALUES(?,?,?,?,?)',
            [
              scope.societyId,
              personId,
              request.display_name,
              user.email_normalized,
              request.contact_phone,
            ],
          );
      }
      const flat = await this.identity.property.flatRow(db, scope, input.flatId);
      assertUnarchived(flat);
      assertUnarchived(await this.identity.property.buildingRow(db, scope, flat.buildingId));
      let occupancyId = input.existingOccupancyId;
      if (occupancyId) {
        const o = (
          await rows<
            RowDataPacket & { person_id: string; flat_id: string; occupancy_type: string }
          >(
            db,
            'SELECT person_id,flat_id,occupancy_type FROM flat_occupancies WHERE society_id=? AND id=? AND starts_on<=? AND (ends_on IS NULL OR ends_on>=?)',
            [scope.societyId, occupancyId, scope.today, scope.today],
          )
        )[0];
        if (
          !o ||
          o.person_id !== personId ||
          o.flat_id !== input.flatId ||
          o.occupancy_type !== input.occupancyType
        )
          throw conflict();
      } else {
        if (input.startsOn > scope.today || (input.endsOn && input.endsOn < scope.today))
          throw conflict();
        occupancyId = await this.occupancy.create(
          db,
          scope,
          input.flatId,
          {
            personId,
            occupancyType: input.occupancyType,
            startsOn: input.startsOn,
            endsOn: input.endsOn,
          },
          audit,
        );
      }
      const membership = await this.identity.member(db, scope.societyId, user, personId);
      await db.execute(
        'UPDATE registration_request_details SET resolved_person_id=?,approved_membership_id=?,approved_occupancy_id=? WHERE society_id=? AND request_id=?',
        [personId, membership, occupancyId, scope.societyId, id],
      );
      await db.execute(
        "UPDATE registration_requests SET status='APPROVED',reviewed_at=?,reviewed_by_membership_id=?,decision_note=? WHERE society_id=? AND id=?",
        [
          sqlTime(this.identity.property.access.clock()),
          scope.membershipId,
          input.note,
          scope.societyId,
          id,
        ],
      );
      await this.identity.property.access.audit(
        db,
        scope,
        'resident.registration_approved',
        'registration_request',
        id,
        audit,
        { personId, membershipId: membership, occupancyId, approvedFlatId: input.flatId },
      );
    });
  }
}
