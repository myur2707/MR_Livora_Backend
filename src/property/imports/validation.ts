import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { rows } from '../../onboarding/repository.js';
import type { TenantScope } from '../access.js';
import type { ImportType } from '../contracts.js';
import type { PropertyService } from '../service.js';
import type { OccupancyService } from '../occupancies.js';
import type { PersonRow } from '../models.js';
import { personSelect, fingerprint } from '../models.js';
import { flatCsvRow, residentCsvRow } from './parser.js';
import type { ParsedCsvRow, CsvIssue, ResidentCsv } from './parser.js';
export interface DecisionRow extends ParsedCsvRow {
  warnings: CsvIssue[];
  targets: { buildingId: string | null; flatId: string | null; personId: string | null };
}
interface BuildingLookup extends RowDataPacket {
  id: string;
  name: string;
  archived_at: string | null;
}
interface FlatLookup extends RowDataPacket {
  id: string;
  archived_at: string | null;
}
export class ImportValidator {
  constructor(
    readonly property: PropertyService,
    readonly occupancy: OccupancyService,
  ) {}
  async validate(
    db: PoolConnection,
    scope: TenantScope,
    type: ImportType,
    parsed: ParsedCsvRow[],
  ): Promise<DecisionRow[]> {
    const decisions: DecisionRow[] = [];
    const duplicateKeys = new Map<string, DecisionRow>();
    const people = new Map<string, ResidentCsv>();
    const buildingNames = new Map<string, string>();
    for (const row of parsed) {
      const decision: DecisionRow = {
        ...row,
        errors: [...row.errors],
        warnings: [],
        targets: { buildingId: null, flatId: null, personId: null },
      };
      decisions.push(decision);
      if (decision.errors.length) continue;
      const error = (field: string, code: string, message: string) =>
        decision.errors.push({ field, code, message });
      const buildingCode = row.values['building_code'] ?? '';
      const building = (
        await rows<BuildingLookup>(
          db,
          'SELECT id,name,archived_at FROM buildings WHERE society_id=? AND code=?',
          [scope.societyId, buildingCode],
        )
      )[0];
      decision.targets.buildingId = building?.id ?? null;
      if (building?.archived_at)
        error('building_code', 'ARCHIVED_BUILDING', 'This building is archived.');
      const duplicateKey =
        type === 'FLATS'
          ? fingerprint([
              buildingCode.toLocaleLowerCase('en-US'),
              row.values['flat_number']?.toLocaleLowerCase('en-US'),
            ])
          : fingerprint(row.values);
      const prior = duplicateKeys.get(duplicateKey);
      if (prior) {
        error('row', 'DUPLICATE_ROW', 'This row duplicates another CSV row.');
        prior.errors.push({
          field: 'row',
          code: 'DUPLICATE_ROW',
          message: 'This row duplicates another CSV row.',
        });
      } else duplicateKeys.set(duplicateKey, decision);
      if (type === 'FLATS') {
        const input = flatCsvRow.parse(row.values);
        const knownName = buildingNames.get(buildingCode.toLocaleLowerCase('en-US'));
        if (
          (building && building.name !== input.building_name) ||
          (knownName !== undefined && knownName !== input.building_name)
        )
          error(
            'building_name',
            'BUILDING_MISMATCH',
            'The building code has a different recorded name.',
          );
        buildingNames.set(buildingCode.toLocaleLowerCase('en-US'), input.building_name);
        if (
          building &&
          (
            await rows(
              db,
              'SELECT id FROM flats WHERE society_id=? AND building_id=? AND flat_number=?',
              [scope.societyId, building.id, input.flat_number],
            )
          ).length
        )
          error(
            'flat_number',
            'DUPLICATE_FLAT',
            'This flat already exists, including archived flats.',
          );
        continue;
      }
      const input = residentCsvRow.parse(row.values);
      if (!building)
        error(
          'building_code',
          'BUILDING_NOT_FOUND',
          'Create the building before importing residents.',
        );
      const flat = building
        ? (
            await rows<FlatLookup>(
              db,
              'SELECT id,archived_at FROM flats WHERE society_id=? AND building_id=? AND flat_number=?',
              [scope.societyId, building.id, input.flat_number],
            )
          )[0]
        : undefined;
      decision.targets.flatId = flat?.id ?? null;
      if (!flat || flat.archived_at)
        error('flat_number', 'FLAT_NOT_FOUND', 'Choose an existing active flat in this building.');
      const person = (
        await rows<PersonRow>(db, personSelect + ' WHERE p.society_id=? AND r.reference_code=?', [
          scope.societyId,
          input.person_reference,
        ])
      )[0];
      decision.targets.personId = person?.id ?? null;
      const priorPerson = people.get(input.person_reference);
      if (
        priorPerson &&
        (priorPerson.display_name !== input.display_name ||
          priorPerson.contact_email !== input.contact_email ||
          priorPerson.contact_phone !== input.contact_phone)
      )
        error(
          'person_reference',
          'PERSON_MISMATCH',
          'Rows with the same reference must describe the same person.',
        );
      people.set(input.person_reference, input);
      if (person) {
        if (person.archivedAt)
          error('person_reference', 'ARCHIVED_PERSON', 'This resident profile is archived.');
        if (
          person.displayName !== input.display_name ||
          (input.contact_email !== null && person.contactEmail !== input.contact_email) ||
          (input.contact_phone !== null && person.contactPhone !== input.contact_phone)
        )
          error(
            'person_reference',
            'PERSON_MISMATCH',
            'This explicit reference has different resident details. Edit the profile separately.',
          );
        if (
          flat &&
          (await this.occupancy.overlap(db, scope, flat.id, {
            personId: person.id,
            occupancyType: input.occupancy_type,
            startsOn: input.starts_on,
            endsOn: input.ends_on,
          }))
        )
          error(
            'starts_on',
            'OCCUPANCY_OVERLAP',
            'This person already has an overlapping occupancy of this type.',
          );
      } else {
        const similar = await rows(
          db,
          'SELECT person_id FROM society_persons WHERE society_id=? AND archived_at IS NULL AND (display_name=? OR (contact_phone IS NOT NULL AND contact_phone=?)) LIMIT 1',
          [scope.societyId, input.display_name, input.contact_phone],
        );
        const batchSimilar = [...people.entries()].some(
          ([reference, other]) =>
            reference !== input.person_reference &&
            (other.display_name === input.display_name ||
              (input.contact_phone !== null && other.contact_phone === input.contact_phone)),
        );
        if (similar.length || batchSimilar)
          decision.warnings.push({
            field: 'person_reference',
            code: 'SIMILAR_PERSON',
            message:
              'A similar name or phone exists. A distinct reference creates a distinct person; no automatic merge.',
          });
      }
      for (const priorRow of decisions.slice(0, -1)) {
        if (priorRow.errors.length) continue;
        const other = residentCsvRow.safeParse(priorRow.values);
        if (!other.success) continue;
        const value = other.data;
        if (
          value.person_reference === input.person_reference &&
          value.building_code.toLocaleLowerCase('en-US') ===
            input.building_code.toLocaleLowerCase('en-US') &&
          value.flat_number.toLocaleLowerCase('en-US') ===
            input.flat_number.toLocaleLowerCase('en-US') &&
          value.occupancy_type === input.occupancy_type &&
          value.starts_on <= (input.ends_on ?? '9999-12-31') &&
          input.starts_on <= (value.ends_on ?? '9999-12-31')
        )
          error(
            'starts_on',
            'OCCUPANCY_OVERLAP',
            'CSV rows have overlapping dates for the same person, flat and occupancy type.',
          );
      }
    }
    return decisions;
  }
}
