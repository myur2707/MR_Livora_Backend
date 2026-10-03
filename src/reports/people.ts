import type { TenantScope } from '../property/access.js';
import type { ReportSource } from './financial.js';
export function residentsSource(scope: TenantScope): ReportSource {
  return {
    sql: "SELECT sp.id,sp.person_id AS personId,sp.display_name AS displayName,sp.contact_email AS contactEmail,sp.contact_phone AS contactPhone,sp.created_at AS createdAt,IF(sp.archived_at IS NULL,'ACTIVE','ARCHIVED') AS status FROM society_persons sp WHERE sp.society_id=?",
    values: [scope.societyId],
    dateColumn: 'createdAt',
    nameColumn: 'displayName',
    moneyColumns: [],
    searchColumns: ['displayName', 'contactEmail', 'contactPhone'],
  };
}
export function occupancySource(scope: TenantScope): ReportSource {
  return {
    sql: "SELECT o.id,o.flat_id AS flatId,o.person_id AS personId,f.building_id AS buildingId,building.code AS buildingCode,f.flat_number AS flatNumber,sp.display_name AS displayName,o.occupancy_type AS occupancyType,o.starts_on AS startsOn,o.ends_on AS endsOn,CASE WHEN f.archived_at IS NOT NULL OR building.archived_at IS NOT NULL OR sp.archived_at IS NOT NULL THEN 'ARCHIVED' WHEN o.starts_on>? THEN 'FUTURE' WHEN o.ends_on<? THEN 'ENDED' ELSE 'CURRENT' END AS status FROM flat_occupancies o JOIN flats f ON f.society_id=o.society_id AND f.id=o.flat_id JOIN buildings building ON building.society_id=f.society_id AND building.id=f.building_id JOIN society_persons sp ON sp.society_id=o.society_id AND sp.person_id=o.person_id WHERE o.society_id=?",
    values: [scope.today, scope.today, scope.societyId],
    dateColumn: 'startsOn',
    nameColumn: 'displayName',
    moneyColumns: [],
    searchColumns: ['displayName', 'buildingCode', 'flatNumber'],
  };
}
