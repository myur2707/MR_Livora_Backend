import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { Session } from '../auth/types.js';
import { rows, notFound } from '../onboarding/repository.js';
import type { ResidentAccess } from './access.js';
import { flatPolicy, type ResidentScope } from './access.js';
import { page } from './repository.js';
import type { PageQuery } from './contracts.js';
const fields =
  'f.id,f.flat_number AS flatNumber,building.code AS buildingCode,building.name AS buildingName,f.area_sq_ft AS areaSqFt';
const source =
  ' FROM flats f JOIN buildings building ON building.society_id=f.society_id AND building.id=f.building_id';
export class ResidentFlats {
  constructor(readonly access: ResidentAccess) {}
  async list(session: Session, query: PageQuery) {
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session),
        policy = flatPolicy(scope);
      return page<RowDataPacket>(
        db,
        'SELECT ' + fields,
        source + ' WHERE f.society_id=? AND ' + policy.sql,
        [scope.societyId, ...policy.values],
        query,
      );
    });
  }
  async detail(session: Session, id: string) {
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session);
      await this.access.flat(db, scope, id);
      const result = await rows(
        db,
        'SELECT ' + fields + source + ' WHERE f.society_id=? AND f.id=?',
        [scope.societyId, id],
      );
      if (!result[0]) throw notFound();
      return { ...result[0], occupancies: await this.occupancies(db, scope, id) };
    });
  }
  private occupancies(db: PoolConnection, scope: ResidentScope, flatId: string) {
    // Only this person's occupancy dates/types. Never a flat's other residents or contacts.
    return rows(
      db,
      'SELECT occupancy_type AS type,starts_on AS startsOn,ends_on AS endsOn FROM flat_occupancies WHERE society_id=? AND flat_id=? AND person_id=? AND starts_on<=? AND (ends_on IS NULL OR ends_on>=?) ORDER BY starts_on,id',
      [scope.societyId, flatId, scope.personId, scope.today, scope.today],
    );
  }
  async profile(session: Session) {
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session);
      const found = await rows(
        db,
        'SELECT sp.display_name AS displayName,sp.contact_email AS contactEmail,sp.contact_phone AS contactPhone,u.email_normalized AS loginEmail FROM society_persons sp JOIN users u ON u.id=? WHERE sp.society_id=? AND sp.person_id=? AND sp.archived_at IS NULL',
        [scope.userId, scope.societyId, scope.personId],
      );
      if (!found[0]) throw notFound();
      return { ...found[0], societyName: scope.societyName, timezone: scope.timezone };
    });
  }
}
