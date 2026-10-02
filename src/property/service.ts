import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import type { Session, RequestAudit } from '../auth/types.js';
import { ApiError } from '../http/errors.js';
import { sqlTime } from '../auth/repository.js';
import { rows, insert, notFound } from '../onboarding/repository.js';
import type { PropertyAccess, TenantScope } from './access.js';
import type {
  BuildingInput,
  FlatInput,
  PersonInput,
  BuildingQuery,
  FlatQuery,
  PersonQuery,
} from './contracts.js';
import {
  buildingSelect,
  flatSelect,
  personSelect,
  resourceDto,
  assertFresh,
  assertUnarchived,
  like,
} from './models.js';
import type { BuildingRow, FlatRow, PersonRow } from './models.js';
export class PropertyService {
  constructor(readonly access: PropertyAccess) {}
  async buildingRow(db: PoolConnection, scope: TenantScope, id: string): Promise<BuildingRow> {
    const row = (
      await rows<BuildingRow>(db, buildingSelect + ' WHERE b.society_id=? AND b.id=?', [
        scope.societyId,
        id,
      ])
    )[0];
    if (!row) throw notFound();
    return row;
  }
  async flatRow(db: PoolConnection, scope: TenantScope, id: string): Promise<FlatRow> {
    const row = (
      await rows<FlatRow>(db, flatSelect + ' WHERE f.society_id=? AND f.id=?', [
        scope.societyId,
        id,
      ])
    )[0];
    if (!row) throw notFound();
    return row;
  }
  async personRow(db: PoolConnection, scope: TenantScope, id: string): Promise<PersonRow> {
    const row = (
      await rows<PersonRow>(db, personSelect + ' WHERE p.society_id=? AND p.person_id=?', [
        scope.societyId,
        id,
      ])
    )[0];
    if (!row) throw notFound();
    return row;
  }
  async within<T>(
    session: Session,
    write: boolean,
    work: (db: PoolConnection, scope: TenantScope) => Promise<T>,
  ): Promise<T> {
    return this.access.database.transaction(async (db) =>
      work(db, await this.access.tenant(db, session, write)),
    );
  }
  async list(
    session: Session,
    kind: 'buildings' | 'flats' | 'persons',
    query: BuildingQuery | FlatQuery | PersonQuery,
  ) {
    return this.within(session, false, async (db, scope) => {
      const alias = kind === 'buildings' ? 'b' : kind === 'flats' ? 'f' : 'p';
      const table =
        kind === 'buildings'
          ? 'buildings b'
          : kind === 'flats'
            ? 'flats f JOIN buildings b ON b.society_id=f.society_id AND b.id=f.building_id'
            : 'society_persons p LEFT JOIN society_person_references r ON r.society_id=p.society_id AND r.person_id=p.person_id';
      const sortMap: Record<string, string> =
        kind === 'buildings'
          ? { code: 'b.code', name: 'b.name', createdAt: 'b.created_at' }
          : kind === 'flats'
            ? {
                flatNumber: 'f.flat_number',
                buildingCode: 'b.code',
                areaSqFt: 'f.area_sq_ft',
                createdAt: 'f.created_at',
              }
            : {
                displayName: 'p.display_name',
                reference: 'r.reference_code',
                createdAt: 'p.created_at',
              };
      const sort = sortMap[query.sort];
      if (!sort) throw new ApiError(400, 'INVALID_REQUEST', 'Invalid sort field.');
      let where = alias + '.society_id=?';
      const values: (string | number | null)[] = [scope.societyId];
      if (query.state !== 'all')
        where +=
          ' AND ' + alias + '.archived_at IS ' + (query.state === 'active' ? 'NULL' : 'NOT NULL');
      if (query.q) {
        const fields =
          kind === 'buildings'
            ? ['b.code', 'b.name']
            : kind === 'flats'
              ? ['f.flat_number', 'b.code', 'b.name']
              : ['p.display_name', 'p.contact_email', 'p.contact_phone', 'r.reference_code'];
        where += ' AND (' + fields.map((field) => field + " LIKE ? ESCAPE '='").join(' OR ') + ')';
        values.push(...fields.map(() => like(query.q)));
      }
      if (kind === 'flats' && 'buildingId' in query && query.buildingId) {
        where += ' AND f.building_id=?';
        values.push(query.buildingId);
      }
      const total = (
        await rows<RowDataPacket & { total: string | number }>(
          db,
          'SELECT COUNT(*) AS total FROM ' + table + ' WHERE ' + where,
          values,
        )
      )[0]?.total;
      const select =
        kind === 'buildings' ? buildingSelect : kind === 'flats' ? flatSelect : personSelect;
      const data = await rows<BuildingRow | FlatRow | PersonRow>(
        db,
        select +
          ' WHERE ' +
          where +
          ' ORDER BY ' +
          sort +
          ' ' +
          (query.direction === 'asc' ? 'ASC' : 'DESC') +
          ',' +
          alias +
          '.id ASC LIMIT ? OFFSET ?',
        [...values, query.pageSize, (query.page - 1) * query.pageSize],
      );
      return {
        items: data.map(resourceDto),
        total: Number(total),
        page: query.page,
        pageSize: query.pageSize,
      };
    });
  }
  async detail(session: Session, kind: 'buildings' | 'flats' | 'persons', id: string) {
    return this.within(session, false, async (db, scope) =>
      resourceDto(
        kind === 'buildings'
          ? await this.buildingRow(db, scope, id)
          : kind === 'flats'
            ? await this.flatRow(db, scope, id)
            : await this.personRow(db, scope, id),
      ),
    );
  }
  async createBuilding(
    db: PoolConnection,
    scope: TenantScope,
    input: BuildingInput,
    audit: RequestAudit,
  ): Promise<string> {
    const id = await insert(db, 'INSERT INTO buildings(society_id,code,name) VALUES(?,?,?)', [
      scope.societyId,
      input.code,
      input.name,
    ]);
    await this.access.audit(db, scope, 'building.created', 'building', id, audit);
    return id;
  }
  async createFlat(
    db: PoolConnection,
    scope: TenantScope,
    input: FlatInput,
    audit: RequestAudit,
  ): Promise<string> {
    assertUnarchived(await this.buildingRow(db, scope, input.buildingId));
    const id = await insert(
      db,
      'INSERT INTO flats(society_id,building_id,flat_number,area_sq_ft) VALUES(?,?,?,?)',
      [scope.societyId, input.buildingId, input.flatNumber, input.areaSqFt],
    );
    await this.access.audit(db, scope, 'flat.created', 'flat', id, audit);
    return id;
  }
  async createPerson(
    db: PoolConnection,
    scope: TenantScope,
    input: PersonInput,
    audit: RequestAudit,
  ): Promise<string> {
    const person = await insert(db, 'INSERT INTO persons() VALUES()');
    await db.execute(
      'INSERT INTO society_persons(society_id,person_id,display_name,contact_email,contact_phone) VALUES(?,?,?,?,?)',
      [scope.societyId, person, input.displayName, input.contactEmail, input.contactPhone],
    );
    await db.execute(
      'INSERT INTO society_person_references(society_id,person_id,reference_code) VALUES(?,?,?)',
      [
        scope.societyId,
        person,
        input.reference ?? 'P_' + randomUUID().replaceAll('-', '').toUpperCase(),
      ],
    );
    await this.access.audit(db, scope, 'person.created', 'person', person, audit);
    return person;
  }
  async addBuilding(session: Session, input: BuildingInput, audit: RequestAudit) {
    return this.within(session, true, async (db, scope) => ({
      id: await this.createBuilding(db, scope, input, audit),
    }));
  }
  async addFlat(session: Session, input: FlatInput, audit: RequestAudit) {
    return this.within(session, true, async (db, scope) => ({
      id: await this.createFlat(db, scope, input, audit),
    }));
  }
  async addPerson(session: Session, input: PersonInput, audit: RequestAudit) {
    return this.within(session, true, async (db, scope) => ({
      id: await this.createPerson(db, scope, input, audit),
    }));
  }
  async editBuilding(
    session: Session,
    id: string,
    input: BuildingInput & { version: string },
    audit: RequestAudit,
  ): Promise<void> {
    await this.within(session, true, async (db, scope) => {
      const row = await this.buildingRow(db, scope, id);
      assertFresh(row, input.version);
      assertUnarchived(row);
      await db.execute('UPDATE buildings SET code=?,name=? WHERE society_id=? AND id=?', [
        input.code,
        input.name,
        scope.societyId,
        id,
      ]);
      await this.access.audit(db, scope, 'building.updated', 'building', id, audit, {
        fields: ['code', 'name'],
      });
    });
  }
  async editFlat(
    session: Session,
    id: string,
    input: FlatInput & { version: string },
    audit: RequestAudit,
  ): Promise<void> {
    await this.within(session, true, async (db, scope) => {
      const row = await this.flatRow(db, scope, id);
      assertFresh(row, input.version);
      assertUnarchived(row);
      assertUnarchived(await this.buildingRow(db, scope, input.buildingId));
      await db.execute(
        'UPDATE flats SET building_id=?,flat_number=?,area_sq_ft=? WHERE society_id=? AND id=?',
        [input.buildingId, input.flatNumber, input.areaSqFt, scope.societyId, id],
      );
      await this.access.audit(db, scope, 'flat.updated', 'flat', id, audit, {
        fields: ['buildingId', 'flatNumber', 'areaSqFt'],
      });
    });
  }
  async editPerson(
    session: Session,
    id: string,
    input: PersonInput & { version: string },
    audit: RequestAudit,
  ): Promise<void> {
    await this.within(session, true, async (db, scope) => {
      const row = await this.personRow(db, scope, id);
      assertFresh(row, input.version);
      assertUnarchived(row);
      if (row.reference !== null && input.reference !== row.reference)
        throw new ApiError(409, 'REFERENCE_IMMUTABLE', 'Resident references cannot be reassigned.');
      await db.execute(
        'UPDATE society_persons SET display_name=?,contact_email=?,contact_phone=? WHERE society_id=? AND person_id=?',
        [input.displayName, input.contactEmail, input.contactPhone, scope.societyId, id],
      );
      if (row.reference === null)
        await db.execute(
          'INSERT INTO society_person_references(society_id,person_id,reference_code) VALUES(?,?,?)',
          [
            scope.societyId,
            id,
            input.reference ?? 'P_' + randomUUID().replaceAll('-', '').toUpperCase(),
          ],
        );
      await this.access.audit(db, scope, 'person.updated', 'person', id, audit, {
        fields: ['displayName', 'contactEmail', 'contactPhone'],
      });
    });
  }
  async archive(
    session: Session,
    kind: 'buildings' | 'flats' | 'persons',
    id: string,
    version: string,
    audit: RequestAudit,
  ): Promise<void> {
    await this.within(session, true, async (db, scope) => {
      const row =
        kind === 'buildings'
          ? await this.buildingRow(db, scope, id)
          : kind === 'flats'
            ? await this.flatRow(db, scope, id)
            : await this.personRow(db, scope, id);
      assertFresh(row, version);
      if (row.archivedAt !== null) return;
      let dependencies: RowDataPacket[];
      if (kind === 'buildings')
        dependencies = await rows(
          db,
          'SELECT id FROM flats WHERE society_id=? AND building_id=? AND archived_at IS NULL LIMIT 1',
          [scope.societyId, id],
        );
      else {
        const column = kind === 'flats' ? 'flat_id' : 'person_id';
        dependencies = await rows(
          db,
          'SELECT id FROM flat_occupancies WHERE society_id=? AND ' +
            column +
            '=? AND (ends_on IS NULL OR ends_on>=?) LIMIT 1',
          [scope.societyId, id, scope.today],
        );
        if (kind === 'persons' && !dependencies.length)
          dependencies = await rows(
            db,
            "SELECT m.id FROM society_memberships m JOIN users u ON u.id=m.user_id WHERE m.society_id=? AND u.person_id=? AND m.status='ACTIVE' AND m.ended_at IS NULL LIMIT 1",
            [scope.societyId, id],
          );
      }
      if (dependencies.length)
        throw new ApiError(
          409,
          'ARCHIVE_DEPENDENCIES',
          'End ongoing occupancies/memberships or archive active child flats first.',
        );
      const table = kind === 'persons' ? 'society_persons' : kind;
      await db.execute(
        'UPDATE ' +
          table +
          ' SET archived_at=? WHERE society_id=? AND ' +
          (kind === 'persons' ? 'person_id' : 'id') +
          '=?',
        [sqlTime(this.access.clock()), scope.societyId, id],
      );
      const entity = kind === 'buildings' ? 'building' : kind === 'flats' ? 'flat' : 'person';
      await this.access.audit(db, scope, entity + '.archived', entity, id, audit);
    });
  }
}
