import { z } from 'zod';
import { identifier, parse } from '../property/contracts.js';
export { identifier, parse };
export const methods = ['CASH', 'UPI', 'BANK_TRANSFER', 'CHEQUE'] as const;
const amount = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/)
  .refine((v) => /[1-9]/.test(v));
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(v + 'T00:00:00Z');
    return (
      !Number.isNaN(d.getTime()) &&
      d.toISOString().slice(0, 10) === v &&
      v >= '2000-01-01' &&
      v <= '9999-12-31'
    );
  });
const key = z.string().regex(/^[A-Za-z0-9_-]{16,80}$/);
const allocations = z
  .array(z.strictObject({ billId: identifier, amount }))
  .min(1)
  .max(50)
  .refine((v) => new Set(v.map((a) => a.billId)).size === v.length);
const recording = z.strictObject({
  flatId: identifier,
  payerPersonId: identifier,
  collectedByUserId: identifier,
  method: z.enum(methods),
  paymentDate: date,
  amount,
  reference: z.string().trim().max(128).default(''),
  notes: z.string().trim().max(1000).default(''),
  allocations,
  idempotencyKey: key,
});
export const recordInput = recording.refine((v) => v.method === 'CASH' || v.reference.length > 0, {
  message: 'Non-cash payments require a reference.',
  path: ['reference'],
});
export const reverseInput = z.strictObject({
  reason: z.string().trim().min(5).max(500),
  operationDate: date,
  idempotencyKey: key,
});
export const refundInput = z
  .strictObject({
    ...reverseInput.shape,
    amount,
    method: z.enum(methods),
    reference: z.string().trim().max(128).default(''),
    allocations,
  })
  .refine((v) => v.method === 'CASH' || v.reference.length > 0);
export const correctionInput = z.strictObject({
  ...reverseInput.shape,
  replacement: recording
    .omit({ idempotencyKey: true })
    .refine((v) => v.method === 'CASH' || v.reference.length > 0),
});
export const listQuery = z
  .strictObject({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
    q: z.string().trim().max(100).default(''),
    flatId: identifier.optional(),
    from: date.optional(),
    to: date.optional(),
    collectorUserId: identifier.optional(),
    method: z.enum(methods).optional(),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to);
export type RecordInput = z.infer<typeof recordInput>;
export type ReverseInput = z.infer<typeof reverseInput>;
export type RefundInput = z.infer<typeof refundInput>;
export type CorrectionInput = z.infer<typeof correctionInput>;
export type ListQuery = z.infer<typeof listQuery>;
