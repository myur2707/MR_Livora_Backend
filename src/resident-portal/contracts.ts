import { z } from 'zod';
import { identifier, parse } from '../onboarding/contracts.js';
export { identifier, parse };
export const pageQuery = z.strictObject({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
export const billQuery = pageQuery.extend({
  flatId: identifier.optional(),
  status: z.enum(['ALL', 'OUTSTANDING', 'SETTLED']).default('ALL'),
});
const text = (max: number, multiline = false) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !/\p{Cc}/u.test(multiline ? v.replace(/[\n\r\t]/g, '') : v));
export const complaintInput = z.strictObject({
  flatId: identifier,
  title: text(200),
  description: text(4000, true),
});
export type PageQuery = z.infer<typeof pageQuery>;
export type BillQuery = z.infer<typeof billQuery>;
export type ComplaintInput = z.infer<typeof complaintInput>;
