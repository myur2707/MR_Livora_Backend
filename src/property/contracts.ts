import { z } from 'zod';
import { identifier } from '../onboarding/contracts.js';
export { identifier, parse } from '../onboarding/contracts.js';
export const cleanText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !/[\p{Cc}\uFFFD]/u.test(v));
export const referenceCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9_-]{2,63}$/);
export const area = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,7})\.\d{2}$/)
  .refine((v) => Number(v) > 0)
  .nullable();
export const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const n = Date.parse(v + 'T00:00:00Z');
    return v >= '1000-01-01' && Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === v;
  });
export const occupancyTypes = ['OWNER', 'TENANT', 'FAMILY_MEMBER', 'AUTHORIZED_OCCUPANT'] as const;
export const version = z.string().regex(/^[a-f0-9]{64}$/);
export const buildingInput = z.strictObject({ code: cleanText(64), name: cleanText(100) });
export const flatInput = z.strictObject({
  buildingId: identifier,
  flatNumber: cleanText(32),
  areaSqFt: area,
});
export const personInput = z.strictObject({
  displayName: cleanText(160),
  contactEmail: z.string().trim().toLowerCase().max(254).pipe(z.email()).nullable(),
  contactPhone: z
    .string()
    .trim()
    .regex(/^\+?[0-9][0-9 ()-]{5,30}$/)
    .nullable(),
  reference: referenceCode.nullable(),
});
export const occupancyInput = z
  .strictObject({
    personId: identifier,
    occupancyType: z.enum(occupancyTypes),
    startsOn: calendarDate,
    endsOn: calendarDate.nullable(),
  })
  .refine((v) => v.endsOn === null || v.endsOn >= v.startsOn);
export const closeInput = z.strictObject({ version, endsOn: calendarDate });
export const archiveInput = z.strictObject({ version });
export const updateBuilding = buildingInput.extend({ version });
export const updateFlat = flatInput.extend({ version });
export const updatePerson = personInput.extend({ version });
const paging = {
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
};
const directory = {
  ...paging,
  q: z.string().trim().max(100).default(''),
  state: z.enum(['active', 'archived', 'all']).default('active'),
  direction: z.enum(['asc', 'desc']).default('asc'),
};
export const buildingQuery = z.strictObject({
  ...directory,
  sort: z.enum(['code', 'name', 'createdAt']).default('code'),
});
export const flatQuery = z.strictObject({
  ...directory,
  sort: z.enum(['flatNumber', 'buildingCode', 'areaSqFt', 'createdAt']).default('flatNumber'),
  buildingId: identifier.optional(),
});
export const personQuery = z.strictObject({
  ...directory,
  sort: z.enum(['displayName', 'reference', 'createdAt']).default('displayName'),
});
export const occupancyQuery = z.strictObject({
  ...paging,
  filter: z.enum(['current', 'history', 'all']).default('all'),
  occupancyType: z.enum(occupancyTypes).optional(),
  direction: z.enum(['asc', 'desc']).default('desc'),
});
export const importPageQuery = z.strictObject(paging);
export const previewInput = z.strictObject({
  importType: z.enum(['FLATS', 'RESIDENTS']),
  fileName: cleanText(120).refine((v) => /\.csv$/i.test(v) && !/[\\/]/.test(v)),
  replaceBatchId: identifier.optional(),
  csv: z
    .string()
    .min(1)
    .max(262144)
    .refine((v) => Buffer.byteLength(v, 'utf8') <= 262144),
});
export const importConfirmInput = z.strictObject({
  sourceHash: version,
  reviewHash: version,
  confirmed: z.literal(true),
  acknowledgeWarnings: z.boolean(),
});
export const cancelInput = z.strictObject({});
export type BuildingInput = z.infer<typeof buildingInput>;
export type FlatInput = z.infer<typeof flatInput>;
export type PersonInput = z.infer<typeof personInput>;
export type OccupancyInput = z.infer<typeof occupancyInput>;
export type BuildingQuery = z.infer<typeof buildingQuery>;
export type FlatQuery = z.infer<typeof flatQuery>;
export type PersonQuery = z.infer<typeof personQuery>;
export type OccupancyQuery = z.infer<typeof occupancyQuery>;
export type PageQuery = z.infer<typeof importPageQuery>;
export type ImportType = z.infer<typeof previewInput>['importType'];
