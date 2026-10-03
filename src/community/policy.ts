import { z } from 'zod';
export const categories = [
  'MAINTENANCE',
  'PLUMBING',
  'ELECTRICAL',
  'SECURITY',
  'COMMON_AREA',
  'OTHER',
] as const;
export const statuses = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;
export type ComplaintStatus = (typeof statuses)[number];
export const plainText = (max: number, multiline = false) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/\p{Cc}/u.test(multiline ? value.replace(/[\r\n\t]/g, '') : value));
export function canTransition(from: ComplaintStatus, to: ComplaintStatus): boolean {
  return (
    (
      {
        NEW: 'ASSIGNED',
        ASSIGNED: 'IN_PROGRESS',
        IN_PROGRESS: 'RESOLVED',
        RESOLVED: 'CLOSED',
        CLOSED: '',
      } as const
    )[from] === to
  );
}
