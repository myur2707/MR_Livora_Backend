import { z } from 'zod';
import { identifier, parse } from '../property/contracts.js';
export { identifier, parse };
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(value + 'T00:00:00Z');
    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value &&
      value >= '2000-01-01' &&
      value <= '9999-12-31'
    );
  }, 'Use a valid calendar date.');
const amount = z.string().regex(/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/);
export const typeInput = z.strictObject({
  code: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  name: z.string().trim().min(1).max(100),
  frequency: z.enum(['MONTHLY', 'ONE_TIME']),
});
export const configurationInput = z
  .strictObject({
    chargeTypeId: identifier,
    scope: z.enum(['SOCIETY', 'BUILDING', 'FLAT']),
    buildingId: identifier.optional(),
    flatId: identifier.optional(),
    calculationMethod: z.enum(['FLAT_RATE', 'PER_SQ_FT']),
    rate: amount,
    effectiveFrom: date,
    effectiveUntil: date.nullable(),
    eligibility: z.enum(['ALL_FLATS', 'OCCUPIED_ONLY']),
    enabled: z.boolean(),
  })
  .superRefine((input, ctx) => {
    if (
      (input.scope === 'BUILDING') !== !!input.buildingId ||
      (input.scope === 'FLAT') !== !!input.flatId
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Supply only the identifier for the selected scope.',
      });
    if (input.effectiveUntil && input.effectiveUntil < input.effectiveFrom)
      ctx.addIssue({
        code: 'custom',
        path: ['effectiveUntil'],
        message: 'End date cannot precede start date.',
      });
  });
export const periodInput = z
  .strictObject({
    code: z
      .string()
      .trim()
      .regex(/^[A-Z0-9][A-Z0-9_-]{0,31}$/),
    kind: z.enum(['MONTHLY', 'ONE_TIME']),
    startsOn: date,
    endsOn: date,
    dueOn: date,
  })
  .superRefine((input, ctx) => {
    const start = new Date(input.startsOn + 'T00:00:00Z');
    if (Number.isNaN(start.getTime())) return;
    const last = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0))
      .toISOString()
      .slice(0, 10);
    if (
      input.dueOn < input.startsOn ||
      (input.kind === 'ONE_TIME'
        ? input.startsOn !== input.endsOn
        : !input.startsOn.endsWith('-01') || input.endsOn !== last)
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Monthly periods cover one calendar month; one-time periods cover one day. Due date cannot precede start.',
      });
  });
const discount = z.strictObject({
  flatId: identifier,
  kind: z.enum(['FIXED', 'PERCENT']),
  value: amount,
  reason: z.string().trim().min(5).max(500),
});
export const previewInput = z
  .strictObject({
    periodId: identifier,
    flatIds: z.array(identifier).min(1).max(50),
    discounts: z.array(discount).max(50).default([]),
  })
  .superRefine((input, ctx) => {
    if (
      new Set(input.flatIds).size !== input.flatIds.length ||
      new Set(input.discounts.map((d) => d.flatId)).size !== input.discounts.length ||
      input.discounts.some((d) => !input.flatIds.includes(d.flatId))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Select unique flats and at most one discount for each selected flat.',
      });
  });
export const generationInput = z
  .strictObject({
    ...previewInput.shape,
    previewHash: z.string().regex(/^[a-f0-9]{64}$/),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/),
  })
  .superRefine((input, ctx) => {
    const result = previewInput.safeParse(inputWithoutKeys(input));
    if (!result.success)
      ctx.addIssue({ code: 'custom', message: 'Select unique flats and valid discounts.' });
  });
function inputWithoutKeys(input: {
  periodId: string;
  flatIds: string[];
  discounts: z.infer<typeof discount>[];
}) {
  return { periodId: input.periodId, flatIds: input.flatIds, discounts: input.discounts };
}
export const listQuery = z.strictObject({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  q: z.string().trim().max(100).default(''),
  buildingId: identifier.optional(),
  periodId: identifier.optional(),
  status: z.enum(['ALL', 'OUTSTANDING', 'SETTLED']).default('ALL'),
});
export type ConfigurationInput = z.infer<typeof configurationInput>;
export type PreviewInput = z.infer<typeof previewInput>;
export type GenerationInput = z.infer<typeof generationInput>;
export type ListQuery = z.infer<typeof listQuery>;
