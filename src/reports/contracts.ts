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
interface FilterPolicy {
  sorts: readonly ReportQuery['sort'][];
  statuses: readonly ReportQuery['status'][];
  fields: readonly (keyof ReportQuery)[];
}
const billPolicy: FilterPolicy = {
  sorts: ['id', 'date', 'amount', 'outstanding'],
  statuses: [
    'ALL',
    'DRAFT',
    'ISSUED',
    'OUTSTANDING',
    'SETTLED',
    'OVERDUE',
    'UNPAID',
    'PARTIALLY_PAID',
  ],
  fields: ['buildingId', 'flatId', 'periodId'],
};
const eventPolicy: FilterPolicy = {
  sorts: ['id', 'date', 'amount'],
  statuses: ['ALL'],
  fields: ['buildingId', 'flatId', 'collectorUserId', 'method'],
};
const filterPolicies: Record<ReportKind, FilterPolicy> = {
  billing: billPolicy,
  outstanding: billPolicy,
  collection: eventPolicy,
  'cash-collection': eventPolicy,
  payments: {
    ...eventPolicy,
    statuses: ['ALL', 'RECORDED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'REVERSED'],
  },
  residents: { sorts: ['id', 'date', 'name'], statuses: ['ALL', 'ACTIVE', 'ARCHIVED'], fields: [] },
  'flat-occupancy': {
    sorts: ['id', 'date', 'name'],
    statuses: ['ALL', 'CURRENT', 'ENDED', 'FUTURE', 'ARCHIVED'],
    fields: ['buildingId', 'flatId', 'occupancyType'],
  },
};
const scopedFilters = [
  'buildingId',
  'flatId',
  'periodId',
  'collectorUserId',
  'method',
  'occupancyType',
] as const;
export function validateFilters(kind: ReportKind, query: ReportQuery): void {
  const policy = filterPolicies[kind];
  const unsupported = scopedFilters.some(
    (field) => query[field] !== undefined && !policy.fields.includes(field),
  );
  if (
    !policy.sorts.includes(query.sort) ||
    !policy.statuses.includes(query.status) ||
    unsupported ||
    (kind === 'cash-collection' && query.method && query.method !== 'CASH')
  )
    throw new ApiError(400, 'INVALID_REQUEST', 'These filters are not supported by this report.');
}
