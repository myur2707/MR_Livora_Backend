import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { Session, RequestAudit } from '../auth/types.js';
import { ApiError } from '../http/errors.js';
import { rows, insert, notFound } from '../onboarding/repository.js';
import type { TenantScope } from './access.js';
import type { PropertyService } from './service.js';
import type { OccupancyInput, OccupancyQuery } from './contracts.js';
import { occupancySelect, resourceDto, assertFresh, assertUnarchived } from './models.js';
import type { OccupancyRow } from './models.js';
export class OccupancyService {
  constructor(readonly property: PropertyService) {}
  async overlap(
    db: PoolConnection,
    scope: TenantScope,
    flatId: string,
    input: OccupancyInput,
  ): Promise<boolean> {
    return (
      (
        await rows(
          db,
          'SELECT id FROM flat_occupancies WHERE society_id=? AND flat_id=? AND person_id=? AND occupancy_type=? AND starts_on<=? AND (ends_on IS NULL OR ends_on>=?) LIMIT 1',
          [
            scope.societyId,
            flatId,
            input.personId,
            input.occupancyType,
            input.endsOn ?? '9999-12-31',
            input.startsOn,
          ],
        )
      ).length > 0
    );
  }
  async create(
    db: PoolConnection,
    scope: TenantScope,
    flatId: string,
    input: OccupancyInput,
    audit: RequestAudit,
  ): Promise<string> {
    const flat = await this.property.flatRow(db, scope, flatId);
    assertUnarchived(flat);
    assertUnarchived(await this.property.buildingRow(db, scope, flat.buildingId));
    assertUnarchived(await this.property.personRow(db, scope, input.personId));
    if (await this.overlap(db, scope, flatId, input))
      throw new ApiError(
        409,
        'OCCUPANCY_OVERLAP',
        'This person already has an overlapping occupancy of the same type in this flat.',
      );
    const id = await insert(
      db,
      'INSERT INTO flat_occupancies(society_id,flat_id,person_id,occupancy_type,starts_on,ends_on) VALUES(?,?,?,?,?,?)',
      [scope.societyId, flatId, input.personId, input.occupancyType, input.startsOn, input.endsOn],
    );
    await this.property.access.audit(db, scope, 'occupancy.created', 'occupancy', id, audit);
    return id;
  }
  async add(session: Session, flatId: string, input: OccupancyInput, audit: RequestAudit) {
    return this.property.within(session, true, async (db, scope) => ({
      id: await this.create(db, scope, flatId, input, audit),
    }));
  }
  async list(session: Session, flatId: string, query: OccupancyQuery) {
    return this.property.within(session, false, async (db, scope) => {
      await this.property.flatRow(db, scope, flatId);
      let where = 'o.society_id=? AND o.flat_id=?';
      const values: (string | number)[] = [scope.societyId, flatId];
      if (query.filter === 'current') {
        where += ' AND o.starts_on<=? AND (o.ends_on IS NULL OR o.ends_on>=?)';
        values.push(scope.today, scope.today);
      }
      if (query.filter === 'history') {
        where += ' AND o.ends_on IS NOT NULL AND o.ends_on<?';
        values.push(scope.today);
      }
      if (query.occupancyType) {
        where += ' AND o.occupancy_type=?';
        values.push(query.occupancyType);
      }
      const count = (
        await rows<RowDataPacket & { total: string | number }>(
          db,
          'SELECT COUNT(*) AS total FROM flat_occupancies o WHERE ' + where,
          values,
        )
      )[0]?.total;
      const data = await rows<OccupancyRow>(
        db,
        occupancySelect +
          ' WHERE ' +
          where +
          ' ORDER BY o.starts_on ' +
          (query.direction === 'asc' ? 'ASC' : 'DESC') +
          ',o.id DESC LIMIT ? OFFSET ?',
        [...values, query.pageSize, (query.page - 1) * query.pageSize],
      );
      return {
        items: data.map(resourceDto),
        total: Number(count),
        page: query.page,
        pageSize: query.pageSize,
        today: scope.today,
      };
    });
  }
  async close(
    session: Session,
    flatId: string,
    id: string,
    input: { version: string; endsOn: string },
    audit: RequestAudit,
  ): Promise<void> {
    await this.property.within(session, true, async (db, scope) => {
      await this.property.flatRow(db, scope, flatId);
      const row = (
        await rows<OccupancyRow>(
          db,
          occupancySelect + ' WHERE o.society_id=? AND o.flat_id=? AND o.id=?',
          [scope.societyId, flatId, id],
        )
      )[0];
      if (!row) throw notFound();
      assertFresh(row, input.version);
      if (row.endsOn !== null)
        throw new ApiError(
          409,
          'HISTORY_IMMUTABLE',
          'Closed occupancy history cannot be rewritten.',
        );
      if (input.endsOn < row.startsOn)
        throw new ApiError(400, 'INVALID_REQUEST', 'End date must not precede the start date.');
      await db.execute(
        'UPDATE flat_occupancies SET ends_on=? WHERE society_id=? AND flat_id=? AND id=? AND ends_on IS NULL',
        [input.endsOn, scope.societyId, flatId, id],
      );
      await this.property.access.audit(db, scope, 'occupancy.closed', 'occupancy', id, audit);
    });
  }
}
