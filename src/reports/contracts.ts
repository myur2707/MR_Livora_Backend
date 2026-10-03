import { z } from 'zod';
import { identifier, parse, calendarDate, occupancyTypes } from '../property/contracts.js';
import { pageQuery } from '../resident-portal/contracts.js';
import { methods } from '../payments/contracts.js';
import { ApiError } from '../http/errors.js';
export { parse };
export const reportKinds = [
  'outstanding',
  'collection',
  'cash-collection',
  'payments',
  'residents',
  'flat-occupancy',
  'billing',
] as const;
export const reportKind = z.enum(reportKinds);
export type ReportKind = (typeof reportKinds)[number];
export const reportQuery = pageQuery
  .extend({
    from: calendarDate.refine((value) => value >= '2000-01-01' && value <= '2100-12-31').optional(),
    to: calendarDate.refine((value) => value >= '2000-01-01' && value <= '2100-12-31').optional(),
    q: z.string().trim().max(100).default(''),
    sort: z.enum(['id', 'date', 'name', 'amount', 'outstanding']).default('date'),
    direction: z.enum(['ASC', 'DESC']).default('DESC'),
    buildingId: identifier.optional(),
    flatId: identifier.optional(),
    periodId: identifier.optional(),
    collectorUserId: identifier.optional(),
    method: z.enum(methods).optional(),
    occupancyType: z.enum(occupancyTypes).optional(),
    status: z
      .enum([
        'ALL',
        'ACTIVE',
        'ARCHIVED',
        'CURRENT',
        'ENDED',
        'FUTURE',
        'DRAFT',
        'ISSUED',
        'OUTSTANDING',
        'SETTLED',
        'OVERDUE',
        'UNPAID',
        'PARTIALLY_PAID',
        'RECORDED',
        'PARTIALLY_REFUNDED',
        'REFUNDED',
        'REVERSED',
      ])
      .default('ALL'),
  })
  .superRefine((value, ctx) => {
    if (
      !!value.from !== !!value.to ||
      (value.from &&
        value.to &&
        (value.to < value.from || Date.parse(value.to) - Date.parse(value.from) > 365 * 86400000))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Provide both dates in order, covering at most 366 days.',
      });
  });
export type ReportQuery = z.infer<typeof reportQuery>;
export const financialReport = (kind: ReportKind) =>
  !['residents', 'flat-occupancy'].includes(kind);
export function validateFilters(kind: ReportKind, query: ReportQuery): void {
  const billing = kind === 'billing' || kind === 'outstanding',
    people = kind === 'residents',
    occupancy = kind === 'flat-occupancy',
    events = kind === 'collection' || kind === 'cash-collection';
  const sorts = billing
    ? ['id', 'date', 'amount', 'outstanding']
    : people || occupancy
      ? ['id', 'date', 'name']
      : ['id', 'date', 'amount'];
  const statuses = billing
    ? ['ALL', 'DRAFT', 'ISSUED', 'OUTSTANDING', 'SETTLED', 'OVERDUE', 'UNPAID', 'PARTIALLY_PAID']
    : people
      ? ['ALL', 'ACTIVE', 'ARCHIVED']
      : occupancy
        ? ['ALL', 'CURRENT', 'ENDED', 'FUTURE', 'ARCHIVED']
        : events
          ? ['ALL']
          : ['ALL', 'RECORDED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'REVERSED'];
  if (
    !sorts.includes(query.sort) ||
    !statuses.includes(query.status) ||
    (query.periodId && !billing) ||
    (query.method && (billing || people || occupancy)) ||
    (query.collectorUserId && (billing || people || occupancy)) ||
    (query.occupancyType && !occupancy) ||
    (people && (query.buildingId || query.flatId)) ||
    (kind === 'cash-collection' && query.method && query.method !== 'CASH')
  )
    throw new ApiError(400, 'INVALID_REQUEST', 'These filters are not supported by this report.');
}
