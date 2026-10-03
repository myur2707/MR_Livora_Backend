import { ImportLookups, type BuildingLookup } from './lookups.js';
import type { PoolConnection } from 'mysql2/promise';
import type { TenantScope } from '../access.js';
import type { ImportType } from '../contracts.js';
import type { OccupancyService } from '../occupancies.js';
import type { PersonRow } from '../models.js';
import { fingerprint } from '../models.js';
import { flatCsvRow, residentCsvRow } from './parser.js';
import type { ParsedCsvRow, CsvIssue, FlatCsv, ResidentCsv } from './parser.js';
export interface DecisionRow extends ParsedCsvRow {
  warnings: CsvIssue[];
  targets: { buildingId: string | null; flatId: string | null; personId: string | null };
}
function issue(row: DecisionRow, field: string, code: string, message: string): void {
  row.errors.push({ field, code, message });
}
const lower = (value: string) => value.toLocaleLowerCase('en-US');

class ValidationBatch {
  readonly decisions: DecisionRow[] = [];
  private readonly duplicates = new Map<string, DecisionRow>();
  private readonly people = new Map<string, ResidentCsv>();
  private readonly buildingNames = new Map<string, string>();
  private readonly occupancies = new Map<string, { row: DecisionRow; input: ResidentCsv }[]>();
  constructor(
    readonly lookups: ImportLookups,
    readonly occupancy: OccupancyService,
  ) {}
  duplicate(row: DecisionRow, type: ImportType): void {
    const key =
      type === 'FLATS'
        ? fingerprint([
            lower(row.values['building_code'] ?? ''),
            row.values['flat_number']?.toLocaleLowerCase('en-US'),
          ])
        : fingerprint(row.values);
    const prior = this.duplicates.get(key);
    if (!prior) {
      this.duplicates.set(key, row);
      return;
    }
    for (const value of [row, prior])
      issue(value, 'row', 'DUPLICATE_ROW', 'This row duplicates another CSV row.');
  }
  async flat(
    row: DecisionRow,
    input: FlatCsv,
    building: BuildingLookup | undefined,
  ): Promise<void> {
    const key = lower(input.building_code),
      knownName = this.buildingNames.get(key);
    if (
      (building && building.name !== input.building_name) ||
      (knownName !== undefined && knownName !== input.building_name)
    )
      issue(
        row,
        'building_name',
        'BUILDING_MISMATCH',
        'The building code has a different recorded name.',
      );
    this.buildingNames.set(key, input.building_name);
    if (building && (await this.lookups.flat(building.id, input.flat_number)))
      issue(
        row,
        'flat_number',
        'DUPLICATE_FLAT',
        'This flat already exists, including archived flats.',
      );
  }
  private personDetails(row: DecisionRow, input: ResidentCsv, person: PersonRow): void {
    if (person.archivedAt)
      issue(row, 'person_reference', 'ARCHIVED_PERSON', 'This resident profile is archived.');
    if (
      person.displayName !== input.display_name ||
      (input.contact_email !== null && person.contactEmail !== input.contact_email) ||
      (input.contact_phone !== null && person.contactPhone !== input.contact_phone)
    )
      issue(
        row,
        'person_reference',
        'PERSON_MISMATCH',
        'This explicit reference has different resident details. Edit the profile separately.',
      );
  }
  private batchPerson(row: DecisionRow, input: ResidentCsv): void {
    const prior = this.people.get(input.person_reference);
    if (
      prior &&
      (prior.display_name !== input.display_name ||
        prior.contact_email !== input.contact_email ||
        prior.contact_phone !== input.contact_phone)
    )
      issue(
        row,
        'person_reference',
        'PERSON_MISMATCH',
        'Rows with the same reference must describe the same person.',
      );
    this.people.set(input.person_reference, input);
  }
  private async similarity(row: DecisionRow, input: ResidentCsv): Promise<void> {
    const similar = await this.lookups.similar(input);
    const batchSimilar = [...this.people.entries()].some(
      ([reference, other]) =>
        reference !== input.person_reference &&
        (other.display_name === input.display_name ||
          (input.contact_phone !== null && other.contact_phone === input.contact_phone)),
    );
    if (similar || batchSimilar)
      row.warnings.push({
        field: 'person_reference',
        code: 'SIMILAR_PERSON',
        message:
          'A similar name or phone exists. A distinct reference creates a distinct person; no automatic merge.',
      });
  }
  private overlap(row: DecisionRow, input: ResidentCsv): void {
    const key = fingerprint([
      input.person_reference,
      lower(input.building_code),
      lower(input.flat_number),
      input.occupancy_type,
    ]);
    const group = this.occupancies.get(key) ?? [];
    for (const prior of group) {
      if (prior.row.errors.length) continue;
      if (
        prior.input.starts_on <= (input.ends_on ?? '9999-12-31') &&
        input.starts_on <= (prior.input.ends_on ?? '9999-12-31')
      )
        issue(
          row,
          'starts_on',
          'OCCUPANCY_OVERLAP',
          'CSV rows have overlapping dates for the same person, flat and occupancy type.',
        );
    }
    group.push({ row, input });
    this.occupancies.set(key, group);
  }
  async resident(
    row: DecisionRow,
    input: ResidentCsv,
    building: BuildingLookup | undefined,
  ): Promise<void> {
    if (!building)
      issue(
        row,
        'building_code',
        'BUILDING_NOT_FOUND',
        'Create the building before importing residents.',
      );
    const flat = building ? await this.lookups.flat(building.id, input.flat_number) : undefined;
    row.targets.flatId = flat?.id ?? null;
    if (!flat || flat.archived_at)
      issue(
        row,
        'flat_number',
        'FLAT_NOT_FOUND',
        'Choose an existing active flat in this building.',
      );
    const person = await this.lookups.person(input.person_reference);
    row.targets.personId = person?.id ?? null;
    this.batchPerson(row, input);
    if (person) {
      this.personDetails(row, input, person);
      if (
        flat &&
        (await this.occupancy.overlap(this.lookups.db, this.lookups.scope, flat.id, {
          personId: person.id,
          occupancyType: input.occupancy_type,
          startsOn: input.starts_on,
          endsOn: input.ends_on,
        }))
      )
        issue(
          row,
          'starts_on',
          'OCCUPANCY_OVERLAP',
          'This person already has an overlapping occupancy of this type.',
        );
    } else await this.similarity(row, input);
    this.overlap(row, input);
  }
}
export class ImportValidator {
  constructor(readonly occupancy: OccupancyService) {}
  async validate(
    db: PoolConnection,
    scope: TenantScope,
    type: ImportType,
    parsed: ParsedCsvRow[],
  ): Promise<DecisionRow[]> {
    const batch = new ValidationBatch(new ImportLookups(db, scope), this.occupancy);
    for (const row of parsed) {
      const decision: DecisionRow = {
        ...row,
        errors: [...row.errors],
        warnings: [],
        targets: { buildingId: null, flatId: null, personId: null },
      };
      batch.decisions.push(decision);
      if (decision.errors.length) continue;
      const building = await batch.lookups.building(row.values['building_code'] ?? '');
      decision.targets.buildingId = building?.id ?? null;
      if (building?.archived_at)
        issue(decision, 'building_code', 'ARCHIVED_BUILDING', 'This building is archived.');
      batch.duplicate(decision, type);
      if (type === 'FLATS') await batch.flat(decision, flatCsvRow.parse(row.values), building);
      else await batch.resident(decision, residentCsvRow.parse(row.values), building);
    }
    return batch.decisions;
  }
}
