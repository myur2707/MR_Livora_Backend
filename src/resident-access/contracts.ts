import { z } from 'zod';
import { identifier, parse } from '../onboarding/contracts.js';
import { calendarDate as dateOnly, personInput } from '../property/contracts.js';
export { parse, identifier };
export const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email())
  .refine((v) => /^[\x20-\x7e]+$/.test(v));
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !/\p{Cc}/u.test(v));
const password = z.string().min(15).max(128);
const token = z.string().regex(/^[a-zA-Z0-9_-]{43}$/);
const occupancyType = z.enum(['OWNER', 'TENANT', 'FAMILY_MEMBER', 'AUTHORIZED_OCCUPANT']);
export const signupSchema = z.strictObject({ email, password, displayName: text(160) });
export const tokenSchema = z.strictObject({ token });
export const acceptanceSchema = z.strictObject({ token, password: password.optional() });
export const inviteSchema = z.strictObject({
  personId: identifier,
  flatId: identifier,
  confirmed: z.literal(true),
});
export const joinSchema = z.strictObject({
  societyCode: text(64),
  buildingCode: text(64),
  flatNumber: text(32),
  occupancyType,
  displayName: text(160),
  contactPhone: personInput.shape.contactPhone,
  note: text(500).nullable(),
});
export const joinSocietyOptionsSchema = z.strictObject({
  search: z.string().trim().max(80).default(''),
});
export const joinPropertyOptionsSchema = z.strictObject({
  societyCode: text(64),
  search: z.string().trim().max(80).default(''),
});
export const pageSchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  search: z.string().trim().max(80).default(''),
  status: z
    .enum(['PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED', 'APPROVED', 'REJECTED', 'CANCELLED', 'all'])
    .default('PENDING'),
});
export const decisionSchema = z.strictObject({ confirmed: z.literal(true), note: text(500) });
export const approvalSchema = z
  .strictObject({
    confirmed: z.literal(true),
    note: text(500),
    personId: identifier.nullable(),
    flatId: identifier,
    existingOccupancyId: identifier.nullable(),
    occupancyType,
    startsOn: dateOnly,
    endsOn: dateOnly.nullable(),
  })
  .refine((v) => !v.endsOn || v.endsOn >= v.startsOn);
export type JoinInput = z.infer<typeof joinSchema>;
export type JoinPropertyOptionsInput = z.infer<typeof joinPropertyOptionsSchema>;
export type ApprovalInput = z.infer<typeof approvalSchema>;
export type PageInput = z.infer<typeof pageSchema>;
