import { ApiError } from '../http/errors.js';

const maximum = 999999999999n;
export function minor(value: string): bigint {
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(value))
    throw new ApiError(
      422,
      'INVALID_AMOUNT',
      'Use a nonnegative amount with at most two decimal places.',
    );
  const [whole = '0', fraction = ''] = value.split('.');
  return bounded(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')));
}
export function bounded(value: bigint): bigint {
  if (value < 0n || value > maximum)
    throw new ApiError(422, 'AMOUNT_LIMIT', 'The calculated amount exceeds the supported limit.');
  return value;
}
export function money(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  return sign + String(absolute / 100n) + '.' + String(absolute % 100n).padStart(2, '0');
}
export function lineAmount(quantity: string, rate: string): bigint {
  return bounded((minor(quantity) * minor(rate) + 50n) / 100n);
}
export function discountAmount(gross: bigint, kind: 'FIXED' | 'PERCENT', value: string): bigint {
  const units = minor(value);
  if (units === 0n || (kind === 'PERCENT' && units > 10000n))
    throw new ApiError(
      422,
      'INVALID_DISCOUNT',
      'Enter a positive discount; percentages cannot exceed 100.',
    );
  const result = kind === 'FIXED' ? units : (gross * units + 5000n) / 10000n;
  if (result === 0n || result > gross)
    throw new ApiError(
      422,
      'INVALID_DISCOUNT',
      'The discount must be positive and cannot exceed the bill.',
    );
  return result;
}
