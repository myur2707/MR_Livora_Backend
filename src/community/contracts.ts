import { z } from 'zod';
import { identifier, parse } from '../onboarding/contracts.js';
import { pageQuery } from '../resident-portal/contracts.js';
export { identifier, parse, pageQuery };
import { statuses, categories, plainText } from './policy.js';
export { statuses, categories };
export const revision = z.number().int().min(1).max(4294967294);
export const noticeInput = z.strictObject({ title: plainText(200), body: plainText(8000, true) });
export const noticeEdit = noticeInput.extend({ revision });
export const noticeAction = z.strictObject({ revision, action: z.enum(['PUBLISH', 'ARCHIVE']) });
export const noticeQuery = pageQuery.extend({
  status: z.enum(['ALL', 'DRAFT', 'PUBLISHED', 'ARCHIVED']).default('ALL'),
  search: z.string().trim().max(100).default(''),
});
export const complaintQuery = pageQuery.extend({
  status: z.enum(['ALL', ...statuses]).default('ALL'),
  category: z.enum(['ALL', ...categories]).default('ALL'),
});
export const complaintAction = z.strictObject({
  revision,
  status: z.enum(statuses),
  assigneeMembershipId: identifier.optional(),
  note: plainText(1000, true),
});
export type NoticeInput = z.infer<typeof noticeInput>;
export type NoticeQuery = z.infer<typeof noticeQuery>;
export type ComplaintQuery = z.infer<typeof complaintQuery>;
export type ComplaintAction = z.infer<typeof complaintAction>;
