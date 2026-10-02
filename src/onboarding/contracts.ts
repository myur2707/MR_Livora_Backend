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
  .refine((v) => BigInt(v) <= 18446744073709551615n);
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
export const buildingSchema = z
  .strictObject({
    ...revision,
    code: text(64),
    name: text(100),
    flats: z
      .array(
        z.strictObject({
          number: text(32),
          areaSqFt: z
            .string()
            .regex(/^[1-9]\d{0,7}\.\d{2}$/)
            .nullable(),
        }),
      )
      .min(1)
      .max(100),
  })
  .refine(
    (v) => new Set(v.flats.map((f) => f.number.toLocaleLowerCase('en-US'))).size === v.flats.length,
  );
export const residentSchema = z
  .strictObject({
    ...revision,
    flatId: identifier,
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
export const confirmationSchema = z.strictObject({ ...revision, confirmed: z.literal(true) });
export const acceptSchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  password: z.string().min(15).max(128).optional(),
});
export const inspectSchema = acceptSchema.omit({ password: true });
export const residentPageSchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(10000).default(1),
});
export const pageSchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  status: z.enum(statuses).optional(),
});
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ApiError(400, 'INVALID_REQUEST', 'Check the request fields and try again.');
  return result.data;
}
export type CreateSociety = z.infer<typeof createSocietySchema>;
export type BuildingInput = z.infer<typeof buildingSchema>;
export type ResidentInput = z.infer<typeof residentSchema>;
export type MaintenanceInput = z.infer<typeof maintenanceSchema>;
export type PageInput = z.infer<typeof pageSchema>;
