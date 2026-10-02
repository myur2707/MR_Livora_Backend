import type { z } from 'zod';
import type { RowDataPacket } from 'mysql2/promise';
import type { Session, RequestAudit } from '../auth/types.js';
import { rows, insert, notFound } from '../onboarding/repository.js';
import type { BillingAccess } from './access.js';
import { minor, money } from './money.js';
import type { ConfigurationInput, ListQuery, periodInput, typeInput } from './contracts.js';
const resources = {
  'charge-types': {
    table: 'maintenance_charge_types',
    select: "t.id,t.code,t.name,COALESCE(d.frequency,'MONTHLY') AS frequency",
    join: 'LEFT JOIN maintenance_charge_type_details d ON d.society_id=t.society_id AND d.charge_type_id=t.id',
    filter: 't.archived_at IS NULL',
  },
  configurations: {
    table: 'maintenance_charge_configurations',
    select:
      "t.id,t.charge_type_id AS chargeTypeId,c.name AS chargeName,COALESCE(d.scope,IF(t.flat_id IS NULL,'SOCIETY','FLAT')) AS scope,d.building_id AS buildingId,t.flat_id AS flatId,COALESCE(cb.code,fb.code) AS buildingCode,cf.flat_number AS flatNumber,t.calculation_method AS calculationMethod,t.rate,t.effective_from AS effectiveFrom,t.effective_until AS effectiveUntil,t.version,COALESCE(d.eligibility,'ALL_FLATS') AS eligibility,COALESCE(d.enabled,1) AS enabled",
    join: 'JOIN maintenance_charge_types c ON c.society_id=t.society_id AND c.id=t.charge_type_id LEFT JOIN maintenance_configuration_details d ON d.society_id=t.society_id AND d.configuration_id=t.id LEFT JOIN buildings cb ON cb.society_id=t.society_id AND cb.id=d.building_id LEFT JOIN flats cf ON cf.society_id=t.society_id AND cf.id=t.flat_id LEFT JOIN buildings fb ON fb.society_id=cf.society_id AND fb.id=cf.building_id',
    filter: '1=1',
  },
  periods: {
    table: 'billing_periods',
    select:
      "t.id,t.code,t.starts_on AS startsOn,t.ends_on AS endsOn,t.due_on AS dueOn,COALESCE(d.kind,'MONTHLY') AS kind",
    join: 'LEFT JOIN billing_period_details d ON d.society_id=t.society_id AND d.period_id=t.id',
    filter: '1=1',
  },
  buildings: {
    table: 'buildings',
    select: 't.id,t.code,t.name',
    join: '',
    filter: 't.archived_at IS NULL',
  },
  flats: {
    table: 'flats',
    select:
      't.id,t.building_id AS buildingId,b.code AS buildingCode,t.flat_number AS flatNumber,t.area_sq_ft AS areaSqFt',
    join: 'JOIN buildings b ON b.society_id=t.society_id AND b.id=t.building_id',
    filter: 't.archived_at IS NULL AND b.archived_at IS NULL',
  },
} as const;
export type BillingResource = keyof typeof resources;
export class BillingConfiguration {
  constructor(readonly access: BillingAccess) {}
  async list(session: Session, kind: BillingResource, query: ListQuery) {
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session);
      const resource = resources[kind];
      const search =
        kind === 'flats'
          ? 't.flat_number'
          : kind === 'configurations'
            ? 'c.name'
            : kind === 'periods'
              ? 't.code'
              : 't.name';
      const filter =
        't.society_id=? AND ' +
        resource.filter +
        ' AND ' +
        search +
        " LIKE ? ESCAPE '='" +
        (kind === 'flats' && query.buildingId ? ' AND t.building_id=?' : '');
      const values: (string | number)[] = [
        scope.societyId,
        '%' + query.q.replace(/[=%_]/g, '=$&') + '%',
      ];
      if (kind === 'flats' && query.buildingId) values.push(query.buildingId);
      const from = ' FROM ' + resource.table + ' t ' + resource.join + ' WHERE ' + filter;
      const count = await rows<RowDataPacket & { total: number }>(
        db,
        'SELECT COUNT(*) AS total' + from,
        values,
      );
      const items = await rows<RowDataPacket>(
        db,
        'SELECT ' + resource.select + from + ' ORDER BY t.id DESC LIMIT ? OFFSET ?',
        [...values, query.pageSize, (query.page - 1) * query.pageSize],
      );
      return { items, total: count[0]?.total ?? 0, page: query.page, pageSize: query.pageSize };
    });
  }
  async addType(session: Session, input: z.infer<typeof typeInput>, audit: RequestAudit) {
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session, 'society.finance.configure');
      const id = await insert(
        db,
        'INSERT INTO maintenance_charge_types(society_id,code,name) VALUES(?,?,?)',
        [scope.societyId, input.code, input.name],
      );
      await db.execute(
        'INSERT INTO maintenance_charge_type_details(society_id,charge_type_id,frequency,created_by_membership_id) VALUES(?,?,?,?)',
        [scope.societyId, id, input.frequency, scope.membershipId],
      );
      await this.access.audit(
        db,
        scope,
        'BILLING_CHARGE_TYPE_CREATED',
        'maintenance_charge_type',
        id,
        audit,
        { frequency: input.frequency },
      );
      return { id };
    });
  }
  async addConfiguration(session: Session, input: ConfigurationInput, audit: RequestAudit) {
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session, 'society.finance.configure');
      const type = await rows<RowDataPacket>(
        db,
        'SELECT id FROM maintenance_charge_types WHERE society_id=? AND id=? AND archived_at IS NULL',
        [scope.societyId, input.chargeTypeId],
      );
      if (!type[0]) throw notFound();
      if (input.buildingId || input.flatId) {
        const sql =
          input.scope === 'BUILDING'
            ? 'SELECT id FROM buildings WHERE society_id=? AND id=? AND archived_at IS NULL'
            : 'SELECT f.id FROM flats f JOIN buildings b ON b.society_id=f.society_id AND b.id=f.building_id WHERE f.society_id=? AND f.id=? AND f.archived_at IS NULL AND b.archived_at IS NULL';
        if (
          !(
            await rows<RowDataPacket>(db, sql, [
              scope.societyId,
              input.buildingId ?? input.flatId ?? '',
            ])
          )[0]
        )
          throw notFound();
      }
      const versions = await rows<RowDataPacket & { version: number }>(
        db,
        'SELECT COALESCE(MAX(version),0)+1 AS version FROM maintenance_charge_configurations WHERE society_id=? AND charge_type_id=?',
        [scope.societyId, input.chargeTypeId],
      );
      const version = versions[0]?.version ?? 1;
      const id = await insert(
        db,
        'INSERT INTO maintenance_charge_configurations(society_id,charge_type_id,flat_id,calculation_method,rate,effective_from,effective_until,version) VALUES(?,?,?,?,?,?,?,?)',
        [
          scope.societyId,
          input.chargeTypeId,
          input.flatId ?? null,
          input.calculationMethod,
          money(minor(input.rate)),
          input.effectiveFrom,
          input.effectiveUntil,
          version,
        ],
      );
      await db.execute(
        'INSERT INTO maintenance_configuration_details(society_id,configuration_id,scope,building_id,eligibility,enabled,created_by_membership_id) VALUES(?,?,?,?,?,?,?)',
        [
          scope.societyId,
          id,
          input.scope,
          input.buildingId ?? null,
          input.eligibility,
          Number(input.enabled),
          scope.membershipId,
        ],
      );
      await this.access.audit(
        db,
        scope,
        'BILLING_CONFIGURATION_VERSION_CREATED',
        'maintenance_charge_configuration',
        id,
        audit,
        { version, scope: input.scope, enabled: input.enabled },
      );
      return { id, version };
    });
  }
  async addPeriod(session: Session, input: z.infer<typeof periodInput>, audit: RequestAudit) {
    return this.access.database.transaction(async (db) => {
      const scope = await this.access.tenant(db, session, 'society.finance.configure');
      const id = await insert(
        db,
        'INSERT INTO billing_periods(society_id,code,starts_on,ends_on,due_on) VALUES(?,?,?,?,?)',
        [scope.societyId, input.code, input.startsOn, input.endsOn, input.dueOn],
      );
      await db.execute(
        'INSERT INTO billing_period_details(society_id,period_id,kind,created_by_membership_id) VALUES(?,?,?,?)',
        [scope.societyId, id, input.kind, scope.membershipId],
      );
      await this.access.audit(db, scope, 'BILLING_PERIOD_CREATED', 'billing_period', id, audit, {
        kind: input.kind,
      });
      return { id };
    });
  }
}
