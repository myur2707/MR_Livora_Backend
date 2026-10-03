import { z } from 'zod';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { Session, RequestAudit } from '../../auth/types.js';
import { sqlTime } from '../../auth/repository.js';
import { ApiError } from '../../http/errors.js';
import { rows, insert, notFound, utcTimestamp } from '../../onboarding/repository.js';
import type { PropertyService } from '../service.js';
import type { OccupancyService } from '../occupancies.js';
import type { TenantScope } from '../access.js';
import type { ImportType, PageQuery } from '../contracts.js';
import { fingerprint } from '../models.js';
import { parseCsv, storedCsvRow, flatCsvRow, residentCsvRow } from './parser.js';
import type { ParsedCsvRow } from './parser.js';
import { ImportValidator } from './validation.js';
import type { DecisionRow } from './validation.js';
interface BatchRow extends RowDataPacket {
  id: string;
  created_by_membership_id: string;
  import_type: ImportType;
  status: string;
  source_hash: Buffer;
  validation_hash: Buffer;
  total_rows: number;
  error_rows: number;
  warning_rows: number;
  expires_at: string;
  confirmed_at: string | null;
  result_summary: unknown;
  created_at: string;
}
interface StoredRow extends RowDataPacket {
  csv_row_number: number;
  line_number: number;
  row_data: unknown;
  validation_errors: unknown;
  validation_warnings: unknown;
}
const batchSelect =
  'SELECT id,created_by_membership_id,import_type,status,source_hash,validation_hash,total_rows,error_rows,warning_rows,expires_at,confirmed_at,result_summary,created_at FROM society_import_batches';
export class ImportService {
  readonly validator: ImportValidator;
  constructor(
    readonly property: PropertyService,
    readonly occupancy: OccupancyService,
  ) {
    this.validator = new ImportValidator(occupancy);
  }
  private expired(batch: BatchRow): boolean {
    return new Date(utcTimestamp(batch.expires_at) ?? '').getTime() <= this.property.access.clock();
  }
  private summary(batch: BatchRow) {
    return {
      id: batch.id,
      importType: batch.import_type,
      status: batch.status === 'REVIEW' && this.expired(batch) ? 'EXPIRED' : batch.status,
      sourceHash: batch.source_hash.toString('hex'),
      reviewHash: batch.validation_hash.toString('hex'),
      totalRows: batch.total_rows,
      errorRows: batch.error_rows,
      warningRows: batch.warning_rows,
      expiresAt: utcTimestamp(batch.expires_at),
      confirmedAt: utcTimestamp(batch.confirmed_at),
      result: batch.result_summary,
      createdAt: utcTimestamp(batch.created_at),
    };
  }
  private async batch(db: PoolConnection, scope: TenantScope, id: string): Promise<BatchRow> {
    const batch = (
      await rows<BatchRow>(
        db,
        batchSelect + ' WHERE society_id=? AND id=? AND created_by_membership_id=? FOR UPDATE',
        [scope.societyId, id, scope.membershipId],
      )
    )[0];
    if (!batch) throw notFound();
    return batch;
  }
  private assertReview(batch: BatchRow): void {
    if (batch.status !== 'REVIEW' || this.expired(batch))
      throw new ApiError(
        409,
        'IMPORT_UNAVAILABLE',
        'This import is no longer available for confirmation.',
      );
  }
  private digest(source: string, data: DecisionRow[]): string {
    return fingerprint({ source, rows: data });
  }
  private counts(data: DecisionRow[]) {
    return {
      errorRows: data.filter((row) => row.errors.length > 0).length,
      warningRows: data.filter((row) => row.warnings.length > 0).length,
    };
  }
  private async insertRows(
    db: PoolConnection,
    scope: TenantScope,
    id: string,
    data: DecisionRow[],
  ): Promise<void> {
    for (const row of data)
      await db.execute(
        'INSERT INTO society_import_rows(society_id,batch_id,csv_row_number,line_number,row_data,validation_errors,validation_warnings) VALUES(?,?,?,?,?,?,?)',
        [
          scope.societyId,
          id,
          row.rowNumber,
          row.lineNumber,
          JSON.stringify({ values: row.values, targets: row.targets }),
          JSON.stringify(row.errors),
          JSON.stringify(row.warnings),
        ],
      );
  }
  private async loadParsed(
    db: PoolConnection,
    scope: TenantScope,
    id: string,
  ): Promise<ParsedCsvRow[]> {
    const stored = await rows<StoredRow>(
      db,
      'SELECT csv_row_number,line_number,row_data,validation_errors,validation_warnings FROM society_import_rows WHERE society_id=? AND batch_id=? ORDER BY csv_row_number',
      [scope.societyId, id],
    );
    return stored.map((row) => {
      const payload: unknown = row.row_data;
      if (typeof payload !== 'object' || payload === null || !('values' in payload))
        throw new Error('Missing staged CSV data.');
      const parsed = storedCsvRow.parse({
        rowNumber: row.csv_row_number,
        lineNumber: row.line_number,
        values: payload.values,
        errors: row.validation_errors,
      });
      return { ...parsed, errors: parsed.errors.filter((error) => error.code === 'COLUMN_COUNT') };
    });
  }
  private async minimize(
    db: PoolConnection,
    scope: Pick<TenantScope, 'societyId'>,
    id: string,
  ): Promise<void> {
    await db.execute(
      'UPDATE society_import_rows SET row_data=NULL,validation_errors=NULL,validation_warnings=NULL WHERE society_id=? AND batch_id=?',
      [scope.societyId, id],
    );
  }
  private async cancelWithin(
    db: PoolConnection,
    scope: TenantScope,
    id: string,
    audit: RequestAudit,
  ): Promise<void> {
    const batch = await this.batch(db, scope, id);
    this.assertReview(batch);
    await this.minimize(db, scope, id);
    await db.execute(
      "UPDATE society_import_batches SET status='CANCELLED' WHERE society_id=? AND id=?",
      [scope.societyId, id],
    );
    await this.property.access.audit(db, scope, 'import.cancelled', 'import', id, audit);
  }
  async preview(
    session: Session,
    input: { importType: ImportType; csv: string; replaceBatchId?: string | undefined },
    audit: RequestAudit,
  ) {
    const parsed = parseCsv(input.importType, input.csv);
    const sourceHash = fingerprint(input.csv);
    return this.property.within(session, true, async (db, scope) => {
      const pending = await rows<RowDataPacket & { total: string | number }>(
        db,
        "SELECT COUNT(*) AS total FROM society_import_batches WHERE society_id=? AND created_by_membership_id=? AND status='REVIEW' AND expires_at>?",
        [scope.societyId, scope.membershipId, sqlTime(this.property.access.clock())],
      );
      if (Number(pending[0]?.total) >= 20 && !input.replaceBatchId)
        throw new ApiError(
          409,
          'IMPORT_LIMIT',
          'Cancel an older preview before uploading another file.',
        );
      const data = await this.validator.validate(db, scope, input.importType, parsed);
      const counts = this.counts(data);
      const reviewHash = this.digest(sourceHash, data);
      const id = await insert(
        db,
        'INSERT INTO society_import_batches(society_id,created_by_membership_id,import_type,source_hash,validation_hash,total_rows,error_rows,warning_rows,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        [
          scope.societyId,
          scope.membershipId,
          input.importType,
          Buffer.from(sourceHash, 'hex'),
          Buffer.from(reviewHash, 'hex'),
          data.length,
          counts.errorRows,
          counts.warningRows,
          sqlTime(this.property.access.clock() + 86400000),
          sqlTime(this.property.access.clock()),
        ],
      );
      await this.insertRows(db, scope, id, data);
      if (input.replaceBatchId) await this.cancelWithin(db, scope, input.replaceBatchId, audit);
      await this.property.access.audit(db, scope, 'import.previewed', 'import', id, audit, {
        rows: data.length,
        errorRows: counts.errorRows,
        warningRows: counts.warningRows,
      });
      return this.summary(await this.batch(db, scope, id));
    });
  }
  async list(session: Session, page: PageQuery) {
    return this.property.within(session, false, async (db, scope) => {
      const total = (
        await rows<RowDataPacket & { total: string | number }>(
          db,
          'SELECT COUNT(*) AS total FROM society_import_batches WHERE society_id=? AND created_by_membership_id=?',
          [scope.societyId, scope.membershipId],
        )
      )[0]?.total;
      const batches = await rows<BatchRow>(
        db,
        batchSelect +
          ' WHERE society_id=? AND created_by_membership_id=? ORDER BY id DESC LIMIT ? OFFSET ?',
        [scope.societyId, scope.membershipId, page.pageSize, (page.page - 1) * page.pageSize],
      );
      return {
        items: batches.map((batch) => this.summary(batch)),
        total: Number(total),
        page: page.page,
        pageSize: page.pageSize,
      };
    });
  }
  async detail(session: Session, id: string) {
    return this.property.within(session, false, async (db, scope) =>
      this.summary(await this.batch(db, scope, id)),
    );
  }
  async previewRows(session: Session, id: string, page: PageQuery) {
    return this.property.within(session, false, async (db, scope) => {
      const batch = await this.batch(db, scope, id);
      this.assertReview(batch);
      const data = await rows<StoredRow>(
        db,
        'SELECT csv_row_number,line_number,row_data,validation_errors,validation_warnings FROM society_import_rows WHERE society_id=? AND batch_id=? ORDER BY csv_row_number LIMIT ? OFFSET ?',
        [scope.societyId, id, page.pageSize, (page.page - 1) * page.pageSize],
      );
      return {
        items: data.map((row) => ({
          rowNumber: row.csv_row_number,
          lineNumber: row.line_number,
          values: z.object({ values: z.record(z.string(), z.string()) }).parse(row.row_data).values,
          errors: row.validation_errors,
          warnings: row.validation_warnings,
        })),
        total: batch.total_rows,
        page: page.page,
        pageSize: page.pageSize,
      };
    });
  }
  async revalidate(session: Session, id: string, audit: RequestAudit) {
    return this.property.within(session, true, async (db, scope) => {
      const batch = await this.batch(db, scope, id);
      this.assertReview(batch);
      const parsed = await this.loadParsed(db, scope, id);
      // Invalid field errors are regenerated, never trusted from the stored preview.
      for (const row of parsed) {
        const checked =
          batch.import_type === 'FLATS'
            ? flatCsvRow.safeParse(row.values)
            : residentCsvRow.safeParse(row.values);
        if (!checked.success)
          row.errors.push(
            ...checked.error.issues.map((issue) => ({
              field: String(issue.path[0] ?? 'row'),
              code: 'INVALID_FIELD',
              message: 'Check the value, format and allowed length.',
            })),
          );
      }
      const data = await this.validator.validate(db, scope, batch.import_type, parsed);
      const counts = this.counts(data);
      const hash = this.digest(batch.source_hash.toString('hex'), data);
      for (const row of data)
        await db.execute(
          'UPDATE society_import_rows SET row_data=?,validation_errors=?,validation_warnings=? WHERE society_id=? AND batch_id=? AND csv_row_number=?',
          [
            JSON.stringify({ values: row.values, targets: row.targets }),
            JSON.stringify(row.errors),
            JSON.stringify(row.warnings),
            scope.societyId,
            id,
            row.rowNumber,
          ],
        );
      await db.execute(
        'UPDATE society_import_batches SET validation_hash=?,error_rows=?,warning_rows=? WHERE society_id=? AND id=?',
        [Buffer.from(hash, 'hex'), counts.errorRows, counts.warningRows, scope.societyId, id],
      );
      await this.property.access.audit(db, scope, 'import.revalidated', 'import', id, audit, {
        errorRows: counts.errorRows,
        warningRows: counts.warningRows,
      });
      return this.summary(await this.batch(db, scope, id));
    });
  }
  async cancel(session: Session, id: string, audit: RequestAudit): Promise<void> {
    await this.property.within(session, true, async (db, scope) =>
      this.cancelWithin(db, scope, id, audit),
    );
  }
  async confirm(
    session: Session,
    id: string,
    input: { sourceHash: string; reviewHash: string; acknowledgeWarnings: boolean },
    audit: RequestAudit,
  ) {
    return this.property.within(session, true, async (db, scope) => {
      const batch = await this.batch(db, scope, id);
      if (
        input.sourceHash !== batch.source_hash.toString('hex') ||
        input.reviewHash !== batch.validation_hash.toString('hex')
      )
        throw new ApiError(
          409,
          'REVALIDATE_REQUIRED',
          'The reviewed preview changed. Revalidate before importing.',
        );
      if (batch.status === 'CONFIRMED') return this.summary(batch);
      this.assertReview(batch);
      if (batch.error_rows > 0)
        throw new ApiError(409, 'IMPORT_ERRORS', 'Correct all row errors before confirming.');
      if (batch.warning_rows > 0 && !input.acknowledgeWarnings)
        throw new ApiError(
          409,
          'IMPORT_WARNINGS',
          'Acknowledge the duplicate-person warnings before confirming.',
        );
      const parsed = await this.loadParsed(db, scope, id);
      const data = await this.validator.validate(db, scope, batch.import_type, parsed);
      if (
        data.some((row) => row.errors.length) ||
        this.digest(input.sourceHash, data) !== input.reviewHash
      )
        throw new ApiError(
          409,
          'REVALIDATE_REQUIRED',
          'Society data changed. Revalidate the preview before importing.',
        );
      const result = { buildings: 0, flats: 0, persons: 0, occupancies: 0 };
      const buildings = new Map<string, string>();
      const people = new Map<string, string>();
      for (const row of data) {
        try {
          if (batch.import_type === 'FLATS') {
            const value = flatCsvRow.parse(row.values);
            const key = value.building_code.toLocaleLowerCase('en-US');
            let building = row.targets.buildingId ?? buildings.get(key);
            if (!building) {
              building = await this.property.createBuilding(
                db,
                scope,
                { code: value.building_code, name: value.building_name },
                audit,
              );
              result.buildings++;
              buildings.set(key, building);
            }
            await this.property.createFlat(
              db,
              scope,
              { buildingId: building, flatNumber: value.flat_number, areaSqFt: value.area_sq_ft },
              audit,
            );
            result.flats++;
          } else {
            const value = residentCsvRow.parse(row.values);
            let person = row.targets.personId ?? people.get(value.person_reference);
            if (!person) {
              person = await this.property.createPerson(
                db,
                scope,
                {
                  displayName: value.display_name,
                  contactEmail: value.contact_email,
                  contactPhone: value.contact_phone,
                  reference: value.person_reference,
                },
                audit,
              );
              result.persons++;
              people.set(value.person_reference, person);
            }
            if (!row.targets.flatId) throw new Error('Missing validated flat.');
            await this.occupancy.create(
              db,
              scope,
              row.targets.flatId,
              {
                personId: person,
                occupancyType: value.occupancy_type,
                startsOn: value.starts_on,
                endsOn: value.ends_on,
              },
              audit,
            );
            result.occupancies++;
          }
        } catch (error: unknown) {
          if (
            error instanceof ApiError ||
            (typeof error === 'object' &&
              error !== null &&
              'code' in error &&
              typeof error.code === 'string' &&
              ['ER_DUP_ENTRY', 'ER_SIGNAL_EXCEPTION', 'ER_NO_REFERENCED_ROW_2'].includes(
                error.code,
              ))
          )
            throw new ApiError(
              409,
              'IMPORT_ROW_CONFLICT',
              'CSV row ' +
                row.rowNumber +
                ' conflicts with current society data. Revalidate the preview.',
            );
          throw error;
        }
      }
      await this.minimize(db, scope, id);
      await db.execute(
        "UPDATE society_import_batches SET status='CONFIRMED',confirmed_at=?,result_summary=? WHERE society_id=? AND id=?",
        [sqlTime(this.property.access.clock()), JSON.stringify(result), scope.societyId, id],
      );
      await this.property.access.audit(db, scope, 'import.confirmed', 'import', id, audit, result);
      return this.summary(await this.batch(db, scope, id));
    });
  }
  async expire(): Promise<void> {
    // This scheduled system task reads tenant IDs only; each mutation/audit is scoped to that tenant.
    const expired = await this.property.access.database.rows<
      RowDataPacket & { id: string; society_id: string }
    >(
      "SELECT id,society_id FROM society_import_batches WHERE status='REVIEW' AND expires_at<=? ORDER BY expires_at LIMIT 20",
      [sqlTime(this.property.access.clock())],
    );
    for (const item of expired)
      await this.property.access.database.transaction(async (db) => {
        await rows(db, 'SELECT id FROM societies WHERE id=? FOR UPDATE', [item.society_id]);
        const batch = (
          await rows<BatchRow>(
            db,
            batchSelect +
              " WHERE society_id=? AND id=? AND status='REVIEW' AND expires_at<=? FOR UPDATE",
            [item.society_id, item.id, sqlTime(this.property.access.clock())],
          )
        )[0];
        if (!batch) return;
        await this.minimize(db, { societyId: item.society_id }, item.id);
        await db.execute(
          "UPDATE society_import_batches SET status='EXPIRED' WHERE society_id=? AND id=?",
          [item.society_id, item.id],
        );
        await db.execute(
          "INSERT INTO audit_logs(society_id,action,entity_type,entity_id,request_id,safe_metadata) VALUES(?,'import.expired','import',?,'system-expiry',?)",
          [item.society_id, item.id, JSON.stringify({ rows: batch.total_rows })],
        );
      });
  }
}
