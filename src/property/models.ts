import type { RowDataPacket } from 'mysql2/promise';
import { createHash } from 'node:crypto';
import { ApiError } from '../http/errors.js';
import { utcTimestamp } from '../onboarding/repository.js';
export interface BuildingRow extends RowDataPacket {
  id: string;
  code: string;
  name: string;
  archivedAt: string | null;
  createdAt: string;
}
export interface FlatRow extends RowDataPacket {
  id: string;
  buildingId: string;
  buildingCode: string;
  buildingName: string;
  flatNumber: string;
  areaSqFt: string | null;
  archivedAt: string | null;
  createdAt: string;
}
export interface PersonRow extends RowDataPacket {
  id: string;
  displayName: string;
  contactEmail: string | null;
  contactPhone: string | null;
  reference: string | null;
  archivedAt: string | null;
  createdAt: string;
}
export interface OccupancyRow extends RowDataPacket {
  id: string;
  personId: string;
  displayName: string;
  flatId: string;
  buildingCode: string;
  flatNumber: string;
  occupancyType: string;
  startsOn: string;
  endsOn: string | null;
  createdAt: string;
}
export const buildingSelect =
  'SELECT b.id,b.code,b.name,b.archived_at AS archivedAt,b.created_at AS createdAt FROM buildings b';
export const flatSelect =
  'SELECT f.id,f.building_id AS buildingId,b.code AS buildingCode,b.name AS buildingName,f.flat_number AS flatNumber,f.area_sq_ft AS areaSqFt,f.archived_at AS archivedAt,f.created_at AS createdAt FROM flats f JOIN buildings b ON b.society_id=f.society_id AND b.id=f.building_id';
export const personSelect =
  'SELECT p.person_id AS id,p.display_name AS displayName,p.contact_email AS contactEmail,p.contact_phone AS contactPhone,r.reference_code AS reference,p.archived_at AS archivedAt,p.created_at AS createdAt FROM society_persons p LEFT JOIN society_person_references r ON r.society_id=p.society_id AND r.person_id=p.person_id';
export const occupancySelect =
  'SELECT o.id,o.person_id AS personId,p.display_name AS displayName,o.flat_id AS flatId,b.code AS buildingCode,f.flat_number AS flatNumber,o.occupancy_type AS occupancyType,o.starts_on AS startsOn,o.ends_on AS endsOn,o.created_at AS createdAt FROM flat_occupancies o JOIN society_persons p ON p.society_id=o.society_id AND p.person_id=o.person_id JOIN flats f ON f.society_id=o.society_id AND f.id=o.flat_id JOIN buildings b ON b.society_id=f.society_id AND b.id=f.building_id';
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => canonical(item));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]: [string, unknown]) => [key, canonical(item)]),
    );
  return value;
}
export function fingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
export function resourceDto<T extends BuildingRow | FlatRow | PersonRow | OccupancyRow>(row: T) {
  const normalized = {
    ...row,
    createdAt: utcTimestamp(row.createdAt),
    ...('archivedAt' in row ? { archivedAt: utcTimestamp(row.archivedAt) } : {}),
  };
  return { ...normalized, version: fingerprint(normalized) };
}
export function assertFresh(
  row: BuildingRow | FlatRow | PersonRow | OccupancyRow,
  expected: string,
): void {
  if (resourceDto(row).version !== expected)
    throw new ApiError(
      409,
      'REVISION_CONFLICT',
      'This record changed. Refresh before trying again.',
    );
}
export function assertUnarchived(row: BuildingRow | FlatRow | PersonRow): void {
  if (row.archivedAt !== null)
    throw new ApiError(409, 'RESOURCE_ARCHIVED', 'Archived records are read-only.');
}
export const like = (value: string) =>
  '%' + value.replaceAll('=', '==').replaceAll('%', '=%').replaceAll('_', '=_') + '%';
