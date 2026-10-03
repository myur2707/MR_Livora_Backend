import { createHash } from 'node:crypto';
import { minor, money, bounded } from '../billing/money.js';
import { ApiError } from '../http/errors.js';
export { minor, money };
export function validateTotal(
  amount: string,
  allocations: { billId: string; amount: string }[],
): void {
  const total = bounded(allocations.reduce((sum, a) => sum + minor(a.amount), 0n));
  if (minor(amount) <= 0n || total !== minor(amount))
    throw new ApiError(
      422,
      'ALLOCATION_TOTAL',
      'Allocate the exact payment amount to eligible bills.',
    );
}
export function fingerprint(input: object): Buffer {
  return createHash('sha256').update(JSON.stringify(input)).digest();
}
export function canonical<
  T extends { amount: string; allocations: { billId: string; amount: string }[] },
>(input: T): T {
  return {
    ...input,
    amount: money(minor(input.amount)),
    allocations: input.allocations
      .map((a) => ({ ...a, amount: money(minor(a.amount)) }))
      .sort((a, b) => (BigInt(a.billId) < BigInt(b.billId) ? -1 : 1)),
  };
}
