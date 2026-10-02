import { parse as csvParse } from 'csv-parse/sync';
import { z } from 'zod';
import { ApiError } from '../../http/errors.js';
import type { ImportType } from '../contracts.js';
import { cleanText, referenceCode, area, calendarDate, occupancyTypes } from '../contracts.js';
export const importHeaders = {
  FLATS: ['building_code', 'building_name', 'flat_number', 'area_sq_ft'],
  RESIDENTS: [
    'person_reference',
    'display_name',
    'contact_email',
    'contact_phone',
    'building_code',
    'flat_number',
    'occupancy_type',
    'starts_on',
    'ends_on',
  ],
} as const;
const emptyToNull = (value: unknown) => (value === '' ? null : value);
const nullableEmail = z.preprocess(
  emptyToNull,
  z.string().trim().toLowerCase().max(254).pipe(z.email()).nullable(),
);
const nullablePhone = z.preprocess(
  emptyToNull,
  z
    .string()
    .trim()
    .regex(/^\+?[0-9][0-9 ()-]{5,30}$/)
    .nullable(),
);
export const flatCsvRow = z.strictObject({
  building_code: cleanText(64),
  building_name: cleanText(100),
  flat_number: cleanText(32),
  area_sq_ft: z.preprocess(emptyToNull, area),
});
export const residentCsvRow = z
  .strictObject({
    person_reference: referenceCode,
    display_name: cleanText(160),
    contact_email: nullableEmail,
    contact_phone: nullablePhone,
    building_code: cleanText(64),
    flat_number: cleanText(32),
    occupancy_type: z.enum(occupancyTypes),
    starts_on: calendarDate,
    ends_on: z.preprocess(emptyToNull, calendarDate.nullable()),
  })
  .refine((v) => v.ends_on === null || v.ends_on >= v.starts_on, { path: ['ends_on'] });
export type FlatCsv = z.infer<typeof flatCsvRow>;
export type ResidentCsv = z.infer<typeof residentCsvRow>;
export interface CsvIssue {
  field: string;
  code: string;
  message: string;
}
export interface ParsedCsvRow {
  rowNumber: number;
  lineNumber: number;
  values: Record<string, string>;
  errors: CsvIssue[];
}
const recordsSchema = z.array(
  z.object({ record: z.array(z.string()), info: z.object({ lines: z.number().int().positive() }) }),
);
export function parseCsv(type: ImportType, csv: string): ParsedCsvRow[] {
  if (Buffer.byteLength(csv, 'utf8') > 262144 || csv.includes('\0'))
    throw new ApiError(400, 'INVALID_CSV', 'Use a UTF-8 CSV file up to 256 KiB.');
  let parsed: unknown;
  try {
    parsed = csvParse(csv, {
      bom: true,
      info: true,
      trim: true,
      skip_empty_lines: true,
      relax_column_count: true,
      max_record_size: 4096,
      to: 502,
    });
  } catch {
    throw new ApiError(400, 'INVALID_CSV', 'CSV quoting, encoding or record size is invalid.');
  }
  const records = recordsSchema.parse(parsed);
  const headers = importHeaders[type];
  const actual = records[0]?.record;
  if (
    !actual ||
    actual.length !== headers.length ||
    new Set(actual).size !== actual.length ||
    actual.some((v, i) => v !== headers[i])
  )
    throw new ApiError(
      400,
      'INVALID_CSV',
      'Use the exact column headers and order from the template.',
    );
  if (records.length < 2 || records.length > 501)
    throw new ApiError(400, 'INVALID_CSV', 'Import between 1 and 500 data rows per file.');
  return records.slice(1).map((entry, index) => {
    const values = Object.fromEntries(
      headers.map((header, column) => [header, entry.record[column] ?? '']),
    );
    const errors: CsvIssue[] =
      entry.record.length === headers.length
        ? []
        : [
            {
              field: 'row',
              code: 'COLUMN_COUNT',
              message: 'Column count does not match the header.',
            },
          ];
    const checked =
      type === 'FLATS' ? flatCsvRow.safeParse(values) : residentCsvRow.safeParse(values);
    if (!checked.success)
      for (const issue of checked.error.issues)
        errors.push({
          field: String(issue.path[0] ?? 'row'),
          code: 'INVALID_FIELD',
          message: 'Check the value, format and allowed length.',
        });
    return { rowNumber: index + 2, lineNumber: entry.info.lines, values, errors };
  });
}
export const storedCsvRow = z.strictObject({
  rowNumber: z.number().int(),
  lineNumber: z.number().int(),
  values: z.record(z.string(), z.string()),
  errors: z.array(z.strictObject({ field: z.string(), code: z.string(), message: z.string() })),
});
