import type { PoolConnection } from 'mysql2/promise';
import type { Session, RequestAudit } from '../auth/types.js';
import { permissions, tenantRoles, roleCapabilities } from '../auth/types.js';
import { supportContact } from '../auth/support-contact.js';
import { ApiError } from '../http/errors.js';
import { sqlTime } from '../auth/repository.js';
import type {
  CreateSociety,
  BuildingInput,
  BuildingBatchInput,
  RowHousesInput,
  ResidentInput,
  MaintenanceInput,
  ResidentPageInput,
  MaintenancePageInput,
  StructureRecordInput,
  SocietyStatus,
} from './contracts.js';
import { parseStructureDetails } from './contracts.js';
import {
  assertEditable,
  assertTransition,
  assertComplete,
  assertSomethingAdded,
  archivedWingMessage,
  nothingToAddMessage,
  numberKey,
  assertStructureAccess,
} from './policy.js';
import type { AddedNumbers, WingResult } from './policy.js';
import {
  insert,
  rows,
  notFound,
  utcTimestamp,
  displayCounts,
  rowHouseBuildingCode,
} from './repository.js';
import type { OnboardingRepository } from './repository.js';
import type { Scope, SetupRow, Actor } from './repository.js';
export class OnboardingService {
  constructor(readonly repository: OnboardingRepository) {}
  async create(session: Session, input: CreateSociety, audit: RequestAudit) {
    return this.repository.database.transaction(async (db) => {
      const actor = await this.repository.platform(db, session);
      let id: string;
      try {
        id = await insert(
          db,
          "INSERT INTO societies(code,name,timezone,status) VALUES(?,?,?,'DRAFT')",
          [input.code, input.name, input.timezone],
        );
      } catch (error) {
        // A specific code lets the client offer the next free code instead of a generic conflict.
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ER_DUP_ENTRY'
        )
          throw new ApiError(
            409,
            'CODE_TAKEN',
            'This code is already in use. Choose another code.',
          );
        throw error;
      }
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
            counts: { buildings: 0, flats: 0, rowHouses: 0, residents: 0, maintenance: 0 },
            requirements: {
              committee: false,
              buildings: false,
              flats: false,
              residents: false,
              maintenance: false,
            },
            invitation: null,
            events: [],
            structureAccess: { allowed: false, grantedAt: null, revokedAt: null },
            supportContact,
          };
      }
      const { setup } = await this.repository.access(db, session, id, scope);
      const counts = await this.repository.counts(db, id);
      const invitations = await rows(
        db,
        'SELECT id,email_normalized AS email,display_name AS displayName,status,delivery_status AS deliveryStatus,expires_at AS expiresAt FROM society_setup_invitations WHERE society_id=? ORDER BY id DESC LIMIT 1',
        [id],
      );
      // Audit trail: who acted, and for invitations who was invited. Events carry no target,
      // so each invitation event is matched to the invitation its actor created at that moment.
      const events = await rows(
        db,
        "SELECT e.id,e.actor_user_id AS actorUserId,e.action,e.from_status AS fromStatus,e.to_status AS toStatus,e.created_at AS createdAt,COALESCE(sp.display_name,u.email_normalized) AS actorName,u.email_normalized AS actorEmail,i.display_name AS invitedName,i.email_normalized AS invitedEmail,i.status AS invitationStatus,d.details AS details FROM society_onboarding_events e LEFT JOIN society_onboarding_event_details d ON d.society_id=e.society_id AND d.event_id=e.id JOIN users u ON u.id=e.actor_user_id LEFT JOIN society_persons sp ON sp.society_id=e.society_id AND sp.person_id=u.person_id LEFT JOIN society_setup_invitations i ON e.action='committee.invited' AND i.society_id=e.society_id AND i.id=(SELECT x.id FROM society_setup_invitations x WHERE x.society_id=e.society_id AND x.created_by_user_id=e.actor_user_id AND x.created_at<=e.created_at ORDER BY x.created_at DESC,x.id DESC LIMIT 1) WHERE e.society_id=? ORDER BY e.id DESC LIMIT 25",
        [id],
      );
      const structureAccess = await rows(
        db,
        'SELECT allowed,granted_at AS grantedAt,revoked_at AS revokedAt FROM society_onboarding_structure_access WHERE society_id=?',
        [id],
      );
      return {
        id,
        code: setup.code,
        name: setup.name,
        timezone: setup.timezone,
        status: setup.status,
        revision: setup.revision,
        counts: displayCounts(counts),
        requirements: this.repository.requirements(setup, counts),
        invitation: invitations[0]
          ? { ...invitations[0], expiresAt: utcTimestamp(invitations[0]['expiresAt']) }
          : null,
        events: events.map((event) => ({
          ...event,
          createdAt: utcTimestamp(event['createdAt']),
          details: parseStructureDetails(event['details']),
        })),
        reviewed: setup.reviewed_revision === setup.revision,
        reviewedAt: utcTimestamp(setup.reviewed_at),
        verifiedAt: utcTimestamp(setup.verified_at),
        verifierMembershipId: setup.verified_by_membership_id,
        structureAccess: {
          allowed: Number(structureAccess[0]?.['allowed'] ?? 0) === 1,
          grantedAt: utcTimestamp(structureAccess[0]?.['grantedAt']),
          revokedAt: utcTimestamp(structureAccess[0]?.['revokedAt']),
        },
        supportContact,
      };
    });
  }
  async change<T = void>(
    session: Session,
    id: string,
    scope: Scope,
    revision: string,
    work: (db: PoolConnection, setup: SetupRow, actor: Actor) => Promise<T>,
  ): Promise<T> {
    return this.repository.database.transaction(async (db) => {
      const { actor, setup } = await this.repository.access(db, session, id, scope);
      if (setup.revision !== revision)
        throw new ApiError(409, 'REVISION_CONFLICT', 'Setup changed. Refresh before trying again.');
      return work(db, setup, actor);
    });
  }
  private async requireStructureAccess(
    db: PoolConnection,
    id: string,
    scope: Scope,
  ): Promise<void> {
    if (scope === 'platform') return;
    const grant = await rows(
      db,
      'SELECT society_id FROM society_onboarding_structure_access WHERE society_id=? AND allowed=1 FOR SHARE',
      [id],
    );
    assertStructureAccess(scope, grant.length > 0);
  }
  async setStructureAccess(
    session: Session,
    id: string,
    revision: string,
    allowed: boolean,
    audit: RequestAudit,
  ): Promise<void> {
    await this.change(session, id, 'platform', revision, async (db, setup, actor) => {
      assertEditable(setup.status);
      const at = sqlTime(this.repository.clock());
      await db.execute(
        `INSERT INTO society_onboarding_structure_access(society_id,allowed,granted_by_user_id,granted_at,revoked_by_user_id,revoked_at,updated_at)
         VALUES(?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE allowed=VALUES(allowed),granted_by_user_id=VALUES(granted_by_user_id),granted_at=VALUES(granted_at),revoked_by_user_id=VALUES(revoked_by_user_id),revoked_at=VALUES(revoked_at),updated_at=VALUES(updated_at)`,
        [
          id,
          allowed ? 1 : 0,
          allowed ? actor.userId : null,
          allowed ? at : null,
          allowed ? null : actor.userId,
          allowed ? null : at,
          at,
        ],
      );
      await this.repository.advance(db, setup);
      await this.repository.auditEntity(
        db,
        setup,
        actor,
        allowed ? 'structure_access.granted' : 'structure_access.revoked',
        'society',
        id,
        audit,
      );
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
  ): Promise<WingResult> {
    return this.change(session, id, scope, input.revision, async (db, setup, actor) => {
      assertEditable(setup.status);
      await this.requireStructureAccess(db, id, scope);
      const wing = await this.addWing(db, id, input);
      assertSomethingAdded([wing]);
      await this.repository.advance(db, setup);
      await this.repository.event(db, setup, actor, 'building.created', audit, setup.status, {
        kind: 'wings',
        wings: [wing],
      });
      return wing;
    });
  }
  async buildingBatch(
    session: Session,
    id: string,
    scope: Scope,
    input: BuildingBatchInput,
    audit: RequestAudit,
  ): Promise<{ wings: WingResult[] }> {
    return this.change(session, id, scope, input.revision, async (db, setup, actor) => {
      assertEditable(setup.status);
      await this.requireStructureAccess(db, id, scope);
      const wings: WingResult[] = [];
      for (const building of input.buildings) wings.push(await this.addWing(db, id, building));
      assertSomethingAdded(wings);
      await this.repository.advance(db, setup);
      // One event per save; its details list every wing, including skipped numbers.
      await this.repository.event(db, setup, actor, 'building.created', audit, setup.status, {
        kind: 'wings',
        wings,
      });
      return { wings };
    });
  }
  async rowHouses(
    session: Session,
    id: string,
    scope: Scope,
    input: RowHousesInput,
    audit: RequestAudit,
  ): Promise<AddedNumbers> {
    return this.change(session, id, scope, input.revision, async (db, setup, actor) => {
      assertEditable(setup.status);
      await this.requireStructureAccess(db, id, scope);
      // Reuse one tenant-scoped group so later ranges retain house-number uniqueness.
      const groups = await rows(
        db,
        'SELECT id,name,archived_at FROM buildings WHERE society_id=? AND code=?',
        [id, rowHouseBuildingCode],
      );
      const group = groups[0];
      if (group && (group['name'] !== 'Row houses' || group['archived_at'] !== null))
        throw new ApiError(409, 'CONFLICT', 'The row house group is unavailable.');
      const building = group
        ? String(group['id'])
        : await insert(db, 'INSERT INTO buildings(society_id,code,name) VALUES(?,?,?)', [
            id,
            rowHouseBuildingCode,
            'Row houses',
          ]);
      const houses = await this.addNumbers(db, id, building, input.houses);
      if (!houses.added.length)
        throw new ApiError(409, 'NOTHING_TO_ADD', nothingToAddMessage(null, houses.skipped));
      await this.repository.advance(db, setup);
      await this.repository.event(db, setup, actor, 'building.created', audit, setup.status, {
        kind: 'row_houses',
        ...houses,
      });
      return houses;
    });
  }
  /**
   * Adds a new wing, or adds the missing flat numbers to an existing wing with that code.
   * Numbers already in the wing are skipped and reported. An archived wing keeps its code
   * but cannot take new flats during setup.
   */
  private async addWing(
    db: PoolConnection,
    id: string,
    input: Omit<BuildingInput, 'revision'>,
  ): Promise<WingResult> {
    const found = await rows(
      db,
      'SELECT id,code,archived_at FROM buildings WHERE society_id=? AND code=? FOR UPDATE',
      [id, input.code],
    );
    const wing = found[0];
    if (wing?.['archived_at'])
      throw new ApiError(409, 'WING_ARCHIVED', archivedWingMessage(String(wing['code'])));
    const building = wing
      ? String(wing['id'])
      : await insert(db, 'INSERT INTO buildings(society_id,code,name) VALUES(?,?,?)', [
          id,
          input.code,
          input.name,
        ]);
    const numbers = await this.addNumbers(db, id, building, input.flats);
    return { code: wing ? String(wing['code']) : input.code, existing: !!wing, ...numbers };
  }
  /**
   * Inserts only the numbers the building does not have yet. Archived flats keep their number,
   * so they count as present. The unique key stays authoritative for concurrent writers.
   */
  private async addNumbers(
    db: PoolConnection,
    id: string,
    building: string,
    flats: BuildingInput['flats'],
  ): Promise<AddedNumbers> {
    const present = await rows(
      db,
      'SELECT flat_number FROM flats WHERE society_id=? AND building_id=? AND flat_number IN (' +
        flats.map(() => '?').join(',') +
        ')',
      [id, building, ...flats.map((flat) => flat.number)],
    );
    // Matches the schema's case-insensitive collation closely enough to pick what to skip.
    const taken = new Set(present.map((row) => numberKey(String(row['flat_number']))));
    const fresh = flats.filter((flat) => !taken.has(numberKey(flat.number)));
    await this.insertFlats(db, id, building, fresh);
    return {
      added: fresh.map((flat) => flat.number),
      skipped: flats.filter((flat) => taken.has(numberKey(flat.number))).map((flat) => flat.number),
    };
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
    pageSize = 50,
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
        'SELECT f.id,f.building_id AS buildingId,b.name AS buildingName,b.code AS buildingCode,f.flat_number AS flatNumber,f.area_sq_ft AS areaSqFt FROM flats f JOIN buildings b ON b.society_id=f.society_id AND b.id=f.building_id WHERE f.society_id=? AND f.archived_at IS NULL AND b.archived_at IS NULL' +
          typeFilter +
          searchFilter +
          ' ORDER BY b.id,f.id LIMIT ? OFFSET ?',
        [...values, pageSize, (page - 1) * pageSize],
      );
      const count = await rows(
        db,
        'SELECT COUNT(*) AS total FROM flats f JOIN buildings b ON b.society_id=f.society_id AND b.id=f.building_id WHERE f.society_id=? AND f.archived_at IS NULL AND b.archived_at IS NULL' +
          typeFilter +
          searchFilter,
        values,
      );
      const total = Number(count[0]?.['total']);
      return { items, total, page, pageSize };
    });
  }
  private async structureCorrection(db: PoolConnection, id: string, recordId: string) {
    const found = await rows(
      db,
      'SELECT f.id,f.building_id AS buildingId,b.code AS buildingCode FROM flats f JOIN buildings b ON b.society_id=f.society_id AND b.id=f.building_id WHERE f.society_id=? AND f.id=? AND f.archived_at IS NULL AND b.archived_at IS NULL FOR UPDATE',
      [id, recordId],
    );
    if (!found.length) throw notFound();
    const dependencies = await rows(
      db,
      `SELECT o.flat_id FROM flat_occupancies o WHERE o.society_id=? AND o.flat_id=? AND NOT EXISTS (SELECT 1 FROM onboarding_archived_records a WHERE a.society_id=o.society_id AND a.entity_type='occupancy' AND a.entity_id=o.id)
       UNION ALL SELECT flat_id FROM bills WHERE society_id=? AND flat_id=?
       UNION ALL SELECT requested_flat_id FROM registration_requests WHERE society_id=? AND requested_flat_id=?
       UNION ALL SELECT flat_id FROM invitations WHERE society_id=? AND flat_id=? LIMIT 1`,
      [id, recordId, id, recordId, id, recordId, id, recordId],
    );
    if (dependencies.length)
      throw new ApiError(
        409,
        'RECORD_HAS_DEPENDENCIES',
        'This home already has resident, access, or financial activity and cannot be changed here.',
      );
    const buildingId: unknown = found[0]?.['buildingId'];
    const buildingCode: unknown = found[0]?.['buildingCode'];
    if (typeof buildingId !== 'string' || typeof buildingCode !== 'string') throw notFound();
    return { buildingId, buildingCode };
  }
  async editStructure(
    session: Session,
    id: string,
    recordId: string,
    input: StructureRecordInput,
    audit: RequestAudit,
  ) {
    await this.change(session, id, 'committee', input.revision, async (db, setup, actor) => {
      assertEditable(setup.status);
      const record = await this.structureCorrection(db, id, recordId);
      await db.execute('UPDATE flats SET flat_number=?,area_sq_ft=? WHERE society_id=? AND id=?', [
        input.flatNumber,
        input.areaSqFt,
        id,
        recordId,
      ]);
      if (record.buildingCode !== 'ROW_HOUSES' && input.buildingCode && input.buildingName) {
        await db.execute('UPDATE buildings SET code=?,name=? WHERE society_id=? AND id=?', [
          input.buildingCode,
          input.buildingName,
          id,
          record.buildingId,
        ]);
      }
      await this.repository.advance(db, setup);
      await this.repository.auditEntity(db, setup, actor, 'flat.updated', 'flat', recordId, audit);
    });
  }
  async archiveStructure(
    session: Session,
    id: string,
    recordId: string,
    revision: string,
    audit: RequestAudit,
  ) {
    await this.change(session, id, 'committee', revision, async (db, setup, actor) => {
      assertEditable(setup.status);
      const record = await this.structureCorrection(db, id, recordId);
      const archivedAt = sqlTime(this.repository.clock());
      await db.execute('UPDATE flats SET archived_at=? WHERE society_id=? AND id=?', [
        archivedAt,
        id,
        recordId,
      ]);
      const activeHomes = await rows(
        db,
        'SELECT id FROM flats WHERE society_id=? AND building_id=? AND archived_at IS NULL LIMIT 1',
        [id, record.buildingId],
      );
      if (!activeHomes.length) {
        await db.execute('UPDATE buildings SET archived_at=? WHERE society_id=? AND id=?', [
          archivedAt,
          id,
          record.buildingId,
        ]);
        await this.repository.auditEntity(
          db,
          setup,
          actor,
          'building.archived',
          'building',
          record.buildingId,
          audit,
        );
      }
      await this.repository.advance(db, setup);
      await this.repository.auditEntity(db, setup, actor, 'flat.archived', 'flat', recordId, audit);
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
  async residents(session: Session, id: string, query: ResidentPageInput) {
    return this.repository.database.transaction(async (db) => {
      await this.repository.access(db, session, id, 'committee');
      const filters = [
        'o.society_id=?',
        "NOT EXISTS (SELECT 1 FROM onboarding_archived_records a WHERE a.society_id=o.society_id AND a.entity_type='occupancy' AND a.entity_id=o.id)",
      ];
      const values: string[] = [id];
      if (query.search) {
        const pattern =
          '%' +
          query.search.replaceAll('=', '==').replaceAll('%', '=%').replaceAll('_', '=_') +
          '%';
        filters.push("(p.display_name LIKE ? ESCAPE '=' OR f.flat_number LIKE ? ESCAPE '=')");
        values.push(pattern, pattern);
      }
      if (query.occupancyType) {
        filters.push('o.occupancy_type=?');
        values.push(query.occupancyType);
      }
      const where = filters.join(' AND ');
      const data = await rows(
        db,
        'SELECT o.id,o.person_id AS personId,o.flat_id AS flatId,p.display_name AS displayName,b.code AS buildingCode,b.name AS buildingName,f.flat_number AS flatNumber,o.occupancy_type AS occupancyType,o.starts_on AS startsOn,o.ends_on AS endsOn FROM flat_occupancies o JOIN society_persons p ON p.society_id=o.society_id AND p.person_id=o.person_id JOIN flats f ON f.society_id=o.society_id AND f.id=o.flat_id JOIN buildings b ON b.society_id=f.society_id AND b.id=f.building_id WHERE ' +
          where +
          ' ORDER BY o.id DESC LIMIT 20 OFFSET ?',
        [...values, (query.page - 1) * 20],
      );
      const total = await rows(
        db,
        'SELECT COUNT(*) AS total FROM flat_occupancies o JOIN society_persons p ON p.society_id=o.society_id AND p.person_id=o.person_id JOIN flats f ON f.society_id=o.society_id AND f.id=o.flat_id WHERE ' +
          where,
        values,
      );
      return { items: data, total: Number(total[0]?.['total']), page: query.page, pageSize: 20 };
    });
  }
  private async assertResidentCorrectionAllowed(db: PoolConnection, id: string, recordId: string) {
    const found = await rows(
      db,
      "SELECT o.person_id FROM flat_occupancies o WHERE o.society_id=? AND o.id=? AND NOT EXISTS (SELECT 1 FROM onboarding_archived_records a WHERE a.society_id=o.society_id AND a.entity_type='occupancy' AND a.entity_id=o.id) FOR UPDATE",
      [id, recordId],
    );
    const personId: unknown = found[0]?.['person_id'];
    if (typeof personId !== 'string') throw notFound();
    const dependencies = await rows(
      db,
      `SELECT person_id FROM membership_person_links WHERE society_id=? AND person_id=?
       UNION ALL SELECT person_id FROM invitations WHERE society_id=? AND person_id=?
       UNION ALL SELECT payer_person_id FROM payments WHERE society_id=? AND payer_person_id=? LIMIT 1`,
      [id, personId, id, personId, id, personId],
    );
    if (dependencies.length)
      throw new ApiError(
        409,
        'RECORD_HAS_DEPENDENCIES',
        'This resident is already linked to access or financial activity and cannot be changed here.',
      );
    return personId;
  }
  async editResident(
    session: Session,
    id: string,
    recordId: string,
    input: ResidentInput,
    audit: RequestAudit,
  ) {
    await this.change(session, id, 'committee', input.revision, async (db, setup, actor) => {
      assertEditable(setup.status);
      const personId = await this.assertResidentCorrectionAllowed(db, id, recordId);
      const target = await rows(
        db,
        'SELECT f.id FROM flats f JOIN buildings b ON b.society_id=f.society_id AND b.id=f.building_id WHERE f.society_id=? AND f.id=? AND f.archived_at IS NULL AND b.archived_at IS NULL' +
          (input.propertyType ? ' AND (b.code=?)=?' : '') +
          ' FOR SHARE',
        input.propertyType
          ? [id, input.flatId, 'ROW_HOUSES', input.propertyType === 'ROW_HOUSE' ? 1 : 0]
          : [id, input.flatId],
      );
      if (!target.length) throw notFound();
      await db.execute(
        'UPDATE society_persons SET display_name=? WHERE society_id=? AND person_id=?',
        [input.displayName, id, personId],
      );
      await db.execute(
        'UPDATE flat_occupancies SET flat_id=?,occupancy_type=?,starts_on=?,ends_on=? WHERE society_id=? AND id=?',
        [input.flatId, input.occupancyType, input.startsOn, input.endsOn, id, recordId],
      );
      await db.execute('UPDATE society_onboarding SET residents_confirmed=0 WHERE society_id=?', [
        id,
      ]);
      await this.repository.advance(db, setup);
      await this.repository.auditEntity(
        db,
        setup,
        actor,
        'occupancy.updated',
        'occupancy',
        recordId,
        audit,
      );
    });
  }
  async archiveResident(
    session: Session,
    id: string,
    recordId: string,
    revision: string,
    audit: RequestAudit,
  ) {
    await this.change(session, id, 'committee', revision, async (db, setup, actor) => {
      assertEditable(setup.status);
      await this.assertResidentCorrectionAllowed(db, id, recordId);
      await db.execute(
        "INSERT INTO onboarding_archived_records(society_id,entity_type,entity_id,archived_at) VALUES(?,'occupancy',?,?)",
        [id, recordId, sqlTime(this.repository.clock())],
      );
      await db.execute('UPDATE society_onboarding SET residents_confirmed=0 WHERE society_id=?', [
        id,
      ]);
      await this.repository.advance(db, setup);
      await this.repository.auditEntity(
        db,
        setup,
        actor,
        'occupancy.archived',
        'occupancy',
        recordId,
        audit,
      );
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
  async configurations(session: Session, id: string, query: MaintenancePageInput) {
    return this.repository.database.transaction(async (db) => {
      await this.repository.access(db, session, id, 'committee');
      const filters = ['c.society_id=?', 't.archived_at IS NULL'];
      const values: string[] = [id];
      if (query.search) {
        const pattern =
          '%' +
          query.search.replaceAll('=', '==').replaceAll('%', '=%').replaceAll('_', '=_') +
          '%';
        filters.push("(t.code LIKE ? ESCAPE '=' OR t.name LIKE ? ESCAPE '=')");
        values.push(pattern, pattern);
      }
      if (query.method) {
        filters.push('c.calculation_method=?');
        values.push(query.method);
      }
      const where = filters.join(' AND ');
      const items = await rows(
        db,
        'SELECT c.id,t.id AS chargeTypeId,t.code,t.name,c.calculation_method AS method,c.rate,c.effective_from AS effectiveFrom FROM maintenance_charge_configurations c JOIN maintenance_charge_types t ON t.society_id=c.society_id AND t.id=c.charge_type_id WHERE ' +
          where +
          ' ORDER BY c.id DESC LIMIT 20 OFFSET ?',
        [...values, (query.page - 1) * 20],
      );
      const count = await rows(
        db,
        'SELECT COUNT(*) AS total FROM maintenance_charge_configurations c JOIN maintenance_charge_types t ON t.society_id=c.society_id AND t.id=c.charge_type_id WHERE ' +
          where,
        values,
      );
      return { items, total: Number(count[0]?.['total']), page: query.page, pageSize: 20 };
    });
  }
  private async maintenanceCorrection(
    db: PoolConnection,
    id: string,
    recordId: string,
  ): Promise<{ chargeTypeId: string }> {
    const found = await rows(
      db,
      'SELECT c.charge_type_id AS chargeTypeId FROM maintenance_charge_configurations c JOIN maintenance_charge_types t ON t.society_id=c.society_id AND t.id=c.charge_type_id WHERE c.society_id=? AND c.id=? AND t.archived_at IS NULL FOR UPDATE',
      [id, recordId],
    );
    const chargeTypeId: unknown = found[0]?.['chargeTypeId'];
    if (typeof chargeTypeId !== 'string') throw notFound();
    const dependencies = await rows(
      db,
      `SELECT charge_configuration_id FROM bill_items WHERE society_id=? AND charge_configuration_id=?
       UNION ALL SELECT configuration_id FROM maintenance_configuration_details WHERE society_id=? AND configuration_id=? LIMIT 1`,
      [id, recordId, id, recordId],
    );
    if (dependencies.length)
      throw new ApiError(
        409,
        'RECORD_HAS_DEPENDENCIES',
        'This charge is already used by billing and cannot be changed here.',
      );
    return { chargeTypeId };
  }
  async editMaintenance(
    session: Session,
    id: string,
    recordId: string,
    input: MaintenanceInput,
    audit: RequestAudit,
  ) {
    await this.change(session, id, 'committee', input.revision, async (db, setup, actor) => {
      assertEditable(setup.status);
      const record = await this.maintenanceCorrection(db, id, recordId);
      await db.execute(
        'UPDATE maintenance_charge_types SET code=?,name=? WHERE society_id=? AND id=?',
        [input.code, input.name, id, record.chargeTypeId],
      );
      await db.execute(
        'UPDATE maintenance_charge_configurations SET calculation_method=?,rate=?,effective_from=? WHERE society_id=? AND id=?',
        [input.method, input.rate, input.effectiveFrom, id, recordId],
      );
      await db.execute('UPDATE society_onboarding SET maintenance_confirmed=0 WHERE society_id=?', [
        id,
      ]);
      await this.repository.advance(db, setup);
      await this.repository.auditEntity(
        db,
        setup,
        actor,
        'maintenance_configuration.updated',
        'maintenance_charge_configuration',
        recordId,
        audit,
      );
    });
  }
  async archiveMaintenance(
    session: Session,
    id: string,
    recordId: string,
    revision: string,
    audit: RequestAudit,
  ) {
    await this.change(session, id, 'committee', revision, async (db, setup, actor) => {
      assertEditable(setup.status);
      const record = await this.maintenanceCorrection(db, id, recordId);
      await db.execute(
        'UPDATE maintenance_charge_types SET archived_at=? WHERE society_id=? AND id=?',
        [sqlTime(this.repository.clock()), id, record.chargeTypeId],
      );
      await db.execute('UPDATE society_onboarding SET maintenance_confirmed=0 WHERE society_id=?', [
        id,
      ]);
      await this.repository.advance(db, setup);
      await this.repository.auditEntity(
        db,
        setup,
        actor,
        'maintenance_configuration.archived',
        'maintenance_charge_configuration',
        recordId,
        audit,
      );
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
