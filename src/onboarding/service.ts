import type { PoolConnection } from 'mysql2/promise';
import type { Session, RequestAudit } from '../auth/types.js';
import { permissions, tenantRoles, roleCapabilities } from '../auth/types.js';
import { ApiError } from '../http/errors.js';
import { sqlTime } from '../auth/repository.js';
import type {
  CreateSociety,
  BuildingInput,
  BuildingBatchInput,
  RowHousesInput,
  ResidentInput,
  MaintenanceInput,
  SocietyStatus,
} from './contracts.js';
import { assertEditable, assertTransition, assertComplete } from './policy.js';
import { insert, rows, notFound, utcTimestamp } from './repository.js';
import type { OnboardingRepository } from './repository.js';
import type { Scope, SetupRow, Actor } from './repository.js';
export class OnboardingService {
  constructor(readonly repository: OnboardingRepository) {}
  async create(session: Session, input: CreateSociety, audit: RequestAudit) {
    return this.repository.database.transaction(async (db) => {
      const actor = await this.repository.platform(db, session);
      const id = await insert(
        db,
        "INSERT INTO societies(code,name,timezone,status) VALUES(?,?,?,'DRAFT')",
        [input.code, input.name, input.timezone],
      );
      await db.execute('INSERT INTO society_onboarding(society_id) VALUES(?)', [id]);
      for (const permission of permissions)
        await db.execute(
          'INSERT INTO permissions(code,description) VALUES(?,?) ON DUPLICATE KEY UPDATE code=VALUES(code)',
          [permission, permission],
        );
      for (const code of tenantRoles) {
        const role = await insert(db, 'INSERT INTO roles(society_id,code,name) VALUES(?,?,?)', [
          id,
          code,
          code,
        ]);
        for (const permission of roleCapabilities[code])
          await db.execute(
            'INSERT INTO role_permissions(society_id,role_id,permission_id) SELECT ?,?,id FROM permissions WHERE code=?',
            [id, role, permission],
          );
      }
      const setup = await this.repository.setup(db, id);
      await this.repository.event(db, setup, actor, 'society.created', audit, null);
      return { id };
    });
  }
  async detail(session: Session, id: string, scope: Scope) {
    return this.repository.database.transaction(async (db) => {
      if (scope === 'platform') {
        await this.repository.platform(db, session);
        const legacy = await rows(
          db,
          'SELECT s.id,s.code,s.name,s.timezone,s.status FROM societies s WHERE s.id=? AND s.archived_at IS NULL AND NOT EXISTS(SELECT 1 FROM society_onboarding o WHERE o.society_id=s.id)',
          [id],
        );
        if (legacy[0])
          return {
            ...legacy[0],
            revision: null,
            verifiedAt: null,
            reviewedAt: null,
            verifierMembershipId: null,
            reviewed: false,
            counts: { buildings: 0, flats: 0, residents: 0, maintenance: 0 },
            requirements: {
              committee: false,
              buildings: false,
              flats: false,
              residents: false,
              maintenance: false,
            },
            invitation: null,
            events: [],
          };
      }
      const { setup } = await this.repository.access(db, session, id, scope);
      const counts = await this.repository.counts(db, id);
      const invitations = await rows(
        db,
        'SELECT id,email_normalized AS email,display_name AS displayName,status,delivery_status AS deliveryStatus,expires_at AS expiresAt FROM society_setup_invitations WHERE society_id=? ORDER BY id DESC LIMIT 1',
        [id],
      );
      const events = await rows(
        db,
        'SELECT id,actor_user_id AS actorUserId,action,from_status AS fromStatus,to_status AS toStatus,created_at AS createdAt FROM society_onboarding_events WHERE society_id=? ORDER BY id DESC LIMIT 25',
        [id],
      );
      return {
        id,
        code: setup.code,
        name: setup.name,
        timezone: setup.timezone,
        status: setup.status,
        revision: setup.revision,
        counts: {
          buildings: Number(counts.buildings),
          flats: Number(counts.flats),
          residents: Number(counts.residents),
          maintenance: Number(counts.maintenance),
        },
        requirements: this.repository.requirements(setup, counts),
        invitation: invitations[0]
          ? { ...invitations[0], expiresAt: utcTimestamp(invitations[0]['expiresAt']) }
          : null,
        events: events.map((event) => ({ ...event, createdAt: utcTimestamp(event['createdAt']) })),
        reviewed: setup.reviewed_revision === setup.revision,
        reviewedAt: utcTimestamp(setup.reviewed_at),
        verifiedAt: utcTimestamp(setup.verified_at),
        verifierMembershipId: setup.verified_by_membership_id,
      };
    });
  }
  async change(
    session: Session,
    id: string,
    scope: Scope,
    revision: string,
    work: (db: PoolConnection, setup: SetupRow, actor: Actor) => Promise<void>,
  ) {
    await this.repository.database.transaction(async (db) => {
      const { actor, setup } = await this.repository.access(db, session, id, scope);
      if (setup.revision !== revision)
        throw new ApiError(409, 'REVISION_CONFLICT', 'Setup changed. Refresh before trying again.');
      await work(db, setup, actor);
    });
  }
  async transition(
    session: Session,
    id: string,
    revision: string,
    target: SocietyStatus,
    fromStatus: SocietyStatus,
    audit: RequestAudit,
  ) {
    await this.change(session, id, 'platform', revision, async (db, setup, actor) => {
      if (setup.status !== fromStatus)
        throw new ApiError(
          409,
          'REVISION_CONFLICT',
          'Status changed. Refresh before trying again.',
        );
      assertTransition(setup.status, target);
      if (target === 'ACTIVE' && setup.status !== 'SUSPENDED')
        throw new ApiError(
          403,
          'COMMITTEE_VERIFICATION_REQUIRED',
          'The committee must verify and activate this society.',
        );
      if (target === 'PENDING_VERIFICATION')
        assertComplete(this.repository.requirements(setup, await this.repository.counts(db, id)));
      if (target === 'ACTIVE')
        assertComplete(this.repository.requirements(setup, await this.repository.counts(db, id)));
      if (target === 'ACTIVE' && !setup.verified_at)
        throw new ApiError(409, 'SETUP_INCOMPLETE', 'A previously verified society is required.');
      const from = setup.status;
      if (!setup.verified_at) await this.repository.advance(db, setup);
      await db.execute('UPDATE societies SET status=? WHERE id=?', [target, id]);
      setup.status = target;
      await this.repository.event(db, setup, actor, 'society.status_changed', audit, from);
    });
  }
  async building(
    session: Session,
    id: string,
    scope: Scope,
    input: BuildingInput,
    audit: RequestAudit,
  ) {
    await this.change(session, id, scope, input.revision, async (db, setup, actor) => {
      assertEditable(setup.status);
      await this.insertBuilding(db, id, input);
      await this.repository.advance(db, setup);
      await this.repository.event(db, setup, actor, 'building.created', audit);
    });
  }
  async buildingBatch(
    session: Session,
    id: string,
    scope: Scope,
    input: BuildingBatchInput,
    audit: RequestAudit,
  ) {
    await this.change(session, id, scope, input.revision, async (db, setup, actor) => {
      assertEditable(setup.status);
      for (const building of input.buildings) await this.insertBuilding(db, id, building);
      await this.repository.advance(db, setup);
      for (let index = 0; index < input.buildings.length; index++) {
        await this.repository.event(db, setup, actor, 'building.created', audit);
      }
    });
  }
  async rowHouses(
    session: Session,
    id: string,
    scope: Scope,
    input: RowHousesInput,
    audit: RequestAudit,
  ) {
    await this.change(session, id, scope, input.revision, async (db, setup, actor) => {
      assertEditable(setup.status);
      // Reuse one tenant-scoped group so later ranges retain house-number uniqueness.
      const groups = await rows(
        db,
        'SELECT id,name,archived_at FROM buildings WHERE society_id=? AND code=?',
        [id, 'ROW_HOUSES'],
      );
      const group = groups[0];
      if (group && (group['name'] !== 'Row houses' || group['archived_at'] !== null))
        throw new ApiError(409, 'CONFLICT', 'The row house group is unavailable.');
      const building = group
        ? String(group['id'])
        : await insert(db, 'INSERT INTO buildings(society_id,code,name) VALUES(?,?,?)', [
            id,
            'ROW_HOUSES',
            'Row houses',
          ]);
      await this.insertFlats(db, id, building, input.houses);
      await this.repository.advance(db, setup);
      await this.repository.event(db, setup, actor, 'building.created', audit);
    });
  }
  private async insertBuilding(
    db: PoolConnection,
    id: string,
    input: Omit<BuildingInput, 'revision'>,
  ): Promise<void> {
    const building = await insert(db, 'INSERT INTO buildings(society_id,code,name) VALUES(?,?,?)', [
      id,
      input.code,
      input.name,
    ]);
    await this.insertFlats(db, id, building, input.flats);
  }
  private async insertFlats(
    db: PoolConnection,
    id: string,
    building: string,
    flats: BuildingInput['flats'],
  ): Promise<void> {
    for (const flat of flats)
      await db.execute(
        'INSERT INTO flats(society_id,building_id,flat_number,area_sq_ft) VALUES(?,?,?,?)',
        [id, building, flat.number, flat.areaSqFt],
      );
  }
  async structure(
    session: Session,
    id: string,
    scope: Scope,
    page: number,
    propertyType?: 'FLAT' | 'ROW_HOUSE',
    search?: string,
  ) {
    return this.repository.database.transaction(async (db) => {
      await this.repository.access(db, session, id, scope);
      const typeFilter = propertyType ? ' AND (b.code=?)=?' : '';
      const searchFilter = search
        ? " AND (f.flat_number LIKE ? ESCAPE '=' OR b.code LIKE ? ESCAPE '=' OR b.name LIKE ? ESCAPE '=')"
        : '';
      const pattern = search
        ? '%' + search.replaceAll('=', '==').replaceAll('%', '=%').replaceAll('_', '=_') + '%'
        : null;
      const values = [
        id,
        ...(propertyType ? ['ROW_HOUSES', propertyType === 'ROW_HOUSE' ? 1 : 0] : []),
        ...(pattern ? [pattern, pattern, pattern] : []),
      ];
      const items = await rows(
        db,
        'SELECT f.id,b.name AS buildingName,b.code AS buildingCode,f.flat_number AS flatNumber,f.area_sq_ft AS areaSqFt FROM flats f JOIN buildings b ON b.society_id=f.society_id AND b.id=f.building_id WHERE f.society_id=? AND f.archived_at IS NULL AND b.archived_at IS NULL' +
          typeFilter +
          searchFilter +
          ' ORDER BY b.id,f.id LIMIT 50 OFFSET ?',
        [...values, (page - 1) * 50],
      );
      const count = await rows(
        db,
        'SELECT COUNT(*) AS total FROM flats f JOIN buildings b ON b.society_id=f.society_id AND b.id=f.building_id WHERE f.society_id=? AND f.archived_at IS NULL AND b.archived_at IS NULL' +
          typeFilter +
          searchFilter,
        values,
      );
      const total = Number(count[0]?.['total']);
      return { items, total, page, pageSize: 50 };
    });
  }
  async resident(session: Session, id: string, input: ResidentInput, audit: RequestAudit) {
    await this.change(session, id, 'committee', input.revision, async (db, setup, actor) => {
      assertEditable(setup.status);
      if (
        !(
          await rows(
            db,
            'SELECT f.id FROM flats f JOIN buildings b ON b.society_id=f.society_id AND b.id=f.building_id WHERE f.society_id=? AND f.id=? AND f.archived_at IS NULL AND b.archived_at IS NULL' +
              (input.propertyType ? ' AND (b.code=?)=?' : '') +
              ' FOR SHARE',
            input.propertyType
              ? [id, input.flatId, 'ROW_HOUSES', input.propertyType === 'ROW_HOUSE' ? 1 : 0]
              : [id, input.flatId],
          )
        ).length
      )
        throw notFound();
      const person = await insert(db, 'INSERT INTO persons() VALUES()');
      await db.execute(
        'INSERT INTO society_persons(society_id,person_id,display_name) VALUES(?,?,?)',
        [id, person, input.displayName],
      );
      await db.execute(
        'INSERT INTO flat_occupancies(society_id,flat_id,person_id,occupancy_type,starts_on,ends_on) VALUES(?,?,?,?,?,?)',
        [id, input.flatId, person, input.occupancyType, input.startsOn, input.endsOn],
      );
      await db.execute('UPDATE society_onboarding SET residents_confirmed=0 WHERE society_id=?', [
        id,
      ]);
      await this.repository.advance(db, setup);
      await this.repository.event(db, setup, actor, 'resident.created', audit);
    });
  }
  async residents(session: Session, id: string, page: number) {
    return this.repository.database.transaction(async (db) => {
      await this.repository.access(db, session, id, 'committee');
      const data = await rows(
        db,
        'SELECT o.id,p.display_name AS displayName,f.flat_number AS flatNumber,o.occupancy_type AS occupancyType,o.starts_on AS startsOn,o.ends_on AS endsOn FROM flat_occupancies o JOIN society_persons p ON p.society_id=o.society_id AND p.person_id=o.person_id JOIN flats f ON f.society_id=o.society_id AND f.id=o.flat_id WHERE o.society_id=? ORDER BY o.id DESC LIMIT 20 OFFSET ?',
        [id, (page - 1) * 20],
      );
      const total = await rows(
        db,
        'SELECT COUNT(*) AS total FROM flat_occupancies WHERE society_id=?',
        [id],
      );
      return { items: data, total: Number(total[0]?.['total']), page, pageSize: 20 };
    });
  }
  async maintenance(session: Session, id: string, input: MaintenanceInput, audit: RequestAudit) {
    await this.change(session, id, 'committee', input.revision, async (db, setup, actor) => {
      assertEditable(setup.status);
      const type = await insert(
        db,
        'INSERT INTO maintenance_charge_types(society_id,code,name) VALUES(?,?,?)',
        [id, input.code, input.name],
      );
      await db.execute(
        'INSERT INTO maintenance_charge_configurations(society_id,charge_type_id,calculation_method,rate,effective_from,version) VALUES(?,?,?,?,?,1)',
        [id, type, input.method, input.rate, input.effectiveFrom],
      );
      await db.execute('UPDATE society_onboarding SET maintenance_confirmed=0 WHERE society_id=?', [
        id,
      ]);
      await this.repository.advance(db, setup);
      await this.repository.event(db, setup, actor, 'maintenance.created', audit);
    });
  }
  async configurations(session: Session, id: string, page: number) {
    return this.repository.database.transaction(async (db) => {
      await this.repository.access(db, session, id, 'committee');
      const items = await rows(
        db,
        'SELECT c.id,t.name,c.calculation_method AS method,c.rate,c.effective_from AS effectiveFrom FROM maintenance_charge_configurations c JOIN maintenance_charge_types t ON t.society_id=c.society_id AND t.id=c.charge_type_id WHERE c.society_id=? AND t.archived_at IS NULL ORDER BY c.id DESC LIMIT 20 OFFSET ?',
        [id, (page - 1) * 20],
      );
      const total = Number((await this.repository.counts(db, id)).maintenance);
      return { items, total, page, pageSize: 20 };
    });
  }
  async confirm(
    session: Session,
    id: string,
    revision: string,
    section: 'residents' | 'maintenance',
    audit: RequestAudit,
  ) {
    await this.change(session, id, 'committee', revision, async (db, setup, actor) => {
      assertEditable(setup.status);
      if (
        section === 'maintenance' &&
        Number((await this.repository.counts(db, id)).maintenance) === 0
      )
        throw new ApiError(409, 'SETUP_INCOMPLETE', 'Add maintenance configuration first.');
      const column = section === 'residents' ? 'residents_confirmed' : 'maintenance_confirmed';
      await db.execute('UPDATE society_onboarding SET ' + column + '=1 WHERE society_id=?', [id]);
      await this.repository.advance(db, setup);
      await this.repository.event(db, setup, actor, section + '.confirmed', audit);
    });
  }
  async review(session: Session, id: string, revision: string, audit: RequestAudit) {
    await this.change(session, id, 'committee', revision, async (db, setup, actor) => {
      if (!['SETUP_IN_PROGRESS', 'PENDING_VERIFICATION'].includes(setup.status))
        throw new ApiError(409, 'SETUP_LOCKED', 'This society cannot be reviewed.');
      assertComplete(this.repository.requirements(setup, await this.repository.counts(db, id)));
      const from = setup.status;
      await db.execute(
        'UPDATE society_onboarding SET reviewed_revision=revision,reviewed_by_membership_id=?,reviewed_at=? WHERE society_id=?',
        [actor.membershipId, sqlTime(this.repository.clock()), id],
      );
      await db.execute("UPDATE societies SET status='PENDING_VERIFICATION' WHERE id=?", [id]);
      setup.status = 'PENDING_VERIFICATION';
      await this.repository.event(db, setup, actor, 'setup.reviewed', audit, from);
    });
  }
  async activate(session: Session, id: string, revision: string, audit: RequestAudit) {
    await this.change(session, id, 'committee', revision, async (db, setup, actor) => {
      assertTransition(setup.status, 'ACTIVE');
      if (
        setup.status !== 'PENDING_VERIFICATION' ||
        setup.reviewed_revision !== setup.revision ||
        setup.reviewed_by_membership_id !== actor.membershipId
      )
        throw new ApiError(409, 'REVIEW_REQUIRED', 'Review the current setup before activation.');
      assertComplete(this.repository.requirements(setup, await this.repository.counts(db, id)));
      await db.execute(
        'UPDATE society_onboarding SET verified_by_membership_id=?,verified_at=? WHERE society_id=?',
        [actor.membershipId, sqlTime(this.repository.clock()), id],
      );
      await db.execute("UPDATE societies SET status='ACTIVE' WHERE id=?", [id]);
      const from = setup.status;
      setup.status = 'ACTIVE';
      await this.repository.event(db, setup, actor, 'society.activated', audit, from);
    });
  }
}
