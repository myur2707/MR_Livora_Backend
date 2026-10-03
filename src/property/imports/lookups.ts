import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { rows } from '../../onboarding/repository.js';
import type { TenantScope } from '../access.js';
import { personSelect, fingerprint } from '../models.js';
import type { PersonRow } from '../models.js';
import type { ResidentCsv } from './parser.js';
export interface BuildingLookup extends RowDataPacket {
  id: string;
  name: string;
  archived_at: string | null;
}
interface FlatLookup extends RowDataPacket {
  id: string;
  archived_at: string | null;
}
// The cache lives for one validation only. Confirmation always re-reads current tenant data.
export class ImportLookups {
  private readonly buildings = new Map<string, BuildingLookup | undefined>();
  private readonly flats = new Map<string, FlatLookup | undefined>();
  private readonly people = new Map<string, PersonRow | undefined>();
  private readonly similarities = new Map<string, RowDataPacket | undefined>();
  constructor(
    readonly db: PoolConnection,
    readonly scope: TenantScope,
  ) {}
  private async lookup<T extends RowDataPacket>(
    cache: Map<string, T | undefined>,
    key: string,
    read: () => Promise<T[]>,
  ): Promise<T | undefined> {
    if (!cache.has(key)) cache.set(key, (await read())[0]);
    return cache.get(key);
  }
  building(code: string) {
    return this.lookup(this.buildings, code, () =>
      rows<BuildingLookup>(
        this.db,
        'SELECT id,name,archived_at FROM buildings WHERE society_id=? AND code=?',
        [this.scope.societyId, code],
      ),
    );
  }
  flat(buildingId: string, number: string) {
    return this.lookup(this.flats, fingerprint([buildingId, number]), () =>
      rows<FlatLookup>(
        this.db,
        'SELECT id,archived_at FROM flats WHERE society_id=? AND building_id=? AND flat_number=?',
        [this.scope.societyId, buildingId, number],
      ),
    );
  }
  person(reference: string) {
    return this.lookup(this.people, reference, () =>
      rows<PersonRow>(this.db, personSelect + ' WHERE p.society_id=? AND r.reference_code=?', [
        this.scope.societyId,
        reference,
      ]),
    );
  }
  async similar(input: ResidentCsv): Promise<boolean> {
    return !!(await this.lookup(
      this.similarities,
      fingerprint([input.display_name, input.contact_phone]),
      () =>
        rows(
          this.db,
          'SELECT person_id FROM society_persons WHERE society_id=? AND archived_at IS NULL AND (display_name=? OR (contact_phone IS NOT NULL AND contact_phone=?)) LIMIT 1',
          [this.scope.societyId, input.display_name, input.contact_phone],
        ),
    ));
  }
}
