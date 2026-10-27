import { z } from 'zod';
import { ApiError } from '../http/errors.js';
export const statuses = [
  'DRAFT',
  'SETUP_IN_PROGRESS',
  'PENDING_VERIFICATION',
  'ACTIVE',
  'SUSPENDED',
  'DEACTIVATED',
] as const;
export type SocietyStatus = (typeof statuses)[number];
export const identifier = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/)
  .pipe(z.string().refine((v) => BigInt(v) <= 18446744073709551615n));
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !/[\p{Cc}]/u.test(v));
const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email())
  .refine((v) => /^[\x20-\x7e]+$/.test(v));
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const n = Date.parse(v + 'T00:00:00Z');
    return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === v;
  });
const money = z.string().regex(/^(?:0|[1-9]\d{0,9})\.\d{2}$/);
const revision = { revision: identifier };
export const createSocietySchema = z.strictObject({
  code: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_-]{2,63}$/),
  name: text(200),
  timezone: z
    .string()
    .min(1)
    .max(64)
    .refine((v) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: v }).format();
        return true;
      } catch {
        return false;
      }
    }),
});
export const inviteSchema = z.strictObject({ ...revision, email, displayName: text(160) });
export const revisionSchema = z.strictObject(revision);
export const transitionSchema = z.strictObject({
  ...revision,
  fromStatus: z.enum(statuses),
  status: z.enum(statuses),
});
const propertyUnitSchema = z.strictObject({
  number: text(32),
  areaSqFt: z
    .string()
    .regex(/^[1-9]\d{0,7}\.\d{2}$/)
    .nullable(),
});
const wingSchema = z
  .strictObject({
    code: text(64),
    name: text(100),
    flats: z.array(propertyUnitSchema).min(1).max(100),
  })
  .refine(
    (v) => new Set(v.flats.map((f) => f.number.toLocaleLowerCase('en-US'))).size === v.flats.length,
  )
  .refine((v) => v.code.toUpperCase() !== 'ROW_HOUSES');
export const rowHousesSchema = z
  .strictObject({ ...revision, houses: z.array(propertyUnitSchema).min(1).max(200) })
  .refine(
    (v) =>
      new Set(v.houses.map((h) => h.number.toLocaleLowerCase('en-US'))).size === v.houses.length,
  );
export const buildingSchema = wingSchema.safeExtend(revision);
export const buildingBatchSchema = z
  .strictObject({
    ...revision,
    buildings: z.array(wingSchema).min(1).max(10),
  })
  .refine(
    (v) =>
      new Set(v.buildings.map((b) => b.code.toLocaleLowerCase('en-US'))).size ===
      v.buildings.length,
  )
  .refine((v) => v.buildings.reduce((total, b) => total + b.flats.length, 0) <= 500);
export const residentSchema = z
  .strictObject({
    ...revision,
    flatId: identifier,
    propertyType: z.enum(['FLAT', 'ROW_HOUSE']).optional(),
    displayName: text(160),
    occupancyType: z.enum(['OWNER', 'TENANT', 'FAMILY_MEMBER', 'AUTHORIZED_OCCUPANT']),
    startsOn: date,
    endsOn: date.nullable(),
  })
  .refine((v) => v.endsOn === null || v.endsOn >= v.startsOn);
export const maintenanceSchema = z.strictObject({
  ...revision,
  code: z.string().regex(/^[A-Z][A-Z0-9_-]{1,63}$/),
  name: text(100),
  method: z.enum(['FLAT_RATE', 'PER_SQ_FT']),
  rate: money,
  effectiveFrom: date,
});
export const archiveSetupRecordSchema = z.strictObject(revision);
export const structureRecordSchema = z.strictObject({
  ...revision,
  flatNumber: text(32),
  areaSqFt: z
    .string()
    .regex(/^[1-9]\d{0,7}\.\d{2}$/)
    .nullable(),
  buildingCode: z
    .string()
    .regex(/^[A-Z0-9][A-Z0-9_-]{0,63}$/)
    .optional(),
  buildingName: text(100).optional(),
});
export const confirmationSchema = z.strictObject({ ...revision, confirmed: z.literal(true) });
export const acceptSchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  password: z.string().min(15).max(128).optional(),
});
export const inspectSchema = acceptSchema.omit({ password: true });
export const residentPageSchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  search: z.string().trim().max(80).optional(),
  occupancyType: z.enum(['OWNER', 'TENANT', 'FAMILY_MEMBER', 'AUTHORIZED_OCCUPANT']).optional(),
});
export const maintenancePageSchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  search: z.string().trim().max(80).optional(),
  method: z.enum(['FLAT_RATE', 'PER_SQ_FT']).optional(),
});
export const structurePageSchema = residentPageSchema.extend({
  propertyType: z.enum(['FLAT', 'ROW_HOUSE']).optional(),
  search: z.string().trim().max(80).optional(),
  // The resident picker loads 50 at a time; the setup table asks for smaller pages.
  pageSize: z.coerce.number().int().min(1).max(50).default(50),
});
/** Code prefixes for new communities: Society, Flat, Township. The type lives only in the code. */
export const communityTypes = ['SOC', 'FLT', 'TWP'] as const;
export type CommunityType = (typeof communityTypes)[number];
export const pageSchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  status: z.enum(statuses).optional(),
  type: z.enum(communityTypes).optional(),
  search: text(80).optional(),
});
/** Audit trail modules and the audited record types each covers; unknown types read as "other". */
export const auditModules = {
  society_setup: ['society'],
  property: ['building', 'flat', 'person', 'occupancy', 'import'],
  resident_access: ['registration_request', 'invitation'],
  billing: [
    'bill',
    'billing_period',
    'billing_generation_run',
    'maintenance_charge_type',
    'maintenance_charge_configuration',
  ],
  payments: ['payment'],
  community: ['notice', 'complaint'],
  reports: ['report'],
} as const;
export type AuditModule = keyof typeof auditModules;
export const auditTrailSchema = z
  .strictObject({
    page: z.coerce.number().int().min(1).max(10000).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(25),
    societyId: identifier.optional(),
    module: z.enum(Object.keys(auditModules) as [AuditModule, ...AuditModule[]]).optional(),
    from: date.optional(),
    to: date.optional(),
    search: text(80).optional(),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: 'From must not be after to.' });
export type AuditTrailQuery = z.infer<typeof auditTrailSchema>;
export function auditModuleOf(entityType: string): AuditModule | 'other' {
  for (const [module, types] of Object.entries(auditModules) as [AuditModule, readonly string[]][])
    if (types.includes(entityType)) return module;
  return 'other';
}
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ApiError(400, 'INVALID_REQUEST', 'Check the request fields and try again.');
  return result.data;
}
export type CreateSociety = z.infer<typeof createSocietySchema>;
export const nextCodeSchema = z.strictObject({ type: z.enum(communityTypes) });
/** SOC-00001 … SOC-99999, then SOC-100000: five digits minimum, growing as needed. */
export function communityCode(type: CommunityType, sequence: number): string {
  return type + '-' + String(sequence).padStart(5, '0');
}
export type BuildingInput = z.infer<typeof buildingSchema>;
export type RowHousesInput = z.infer<typeof rowHousesSchema>;
export type ResidentInput = z.infer<typeof residentSchema>;
export type MaintenanceInput = z.infer<typeof maintenanceSchema>;
export type StructureRecordInput = z.infer<typeof structureRecordSchema>;
export type ResidentPageInput = z.infer<typeof residentPageSchema>;
export type MaintenancePageInput = z.infer<typeof maintenancePageSchema>;
export type PageInput = z.infer<typeof pageSchema>;

export type BuildingBatchInput = z.infer<typeof buildingBatchSchema>;

/**
 * Structure facts recorded with a setup event: wing codes and flat or row house numbers only.
 * Parsed on read as well as typed on write, so nothing else stored can reach a client.
 */
const numbers = z.array(z.string().max(64)).max(500);
const wingDetail = z.object({
  code: z.string().max(64),
  existing: z.boolean(),
  added: numbers,
  skipped: numbers,
});
export const structureDetailsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('wings'), wings: z.array(wingDetail).max(10) }),
  z.object({ kind: z.literal('row_houses'), added: numbers, skipped: numbers }),
]);
export type StructureDetails = z.infer<typeof structureDetailsSchema>;
/** Stored details that fail to parse are dropped rather than shown. */
export function parseStructureDetails(value: unknown): StructureDetails | null {
  const raw: unknown = typeof value === 'string' ? safeJson(value) : value;
  const parsed = structureDetailsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
