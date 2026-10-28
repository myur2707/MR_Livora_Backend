import { ApiError } from '../http/errors.js';
import type { SocietyStatus } from './contracts.js';
import type { Scope } from './repository.js';
export function assertStructureAccess(scope: Scope, allowed: boolean): void {
  if (scope === 'platform' || allowed) return;
  throw new ApiError(
    403,
    'STRUCTURE_ACCESS_REQUIRED',
    'Contact Mr. Livora support and ask a platform administrator to enable structure additions.',
  );
}
export const transitions: Record<SocietyStatus, readonly SocietyStatus[]> = {
  DRAFT: ['SETUP_IN_PROGRESS', 'DEACTIVATED'],
  SETUP_IN_PROGRESS: ['PENDING_VERIFICATION', 'DEACTIVATED'],
  PENDING_VERIFICATION: ['SETUP_IN_PROGRESS', 'ACTIVE', 'DEACTIVATED'],
  ACTIVE: ['SUSPENDED', 'DEACTIVATED'],
  SUSPENDED: ['ACTIVE', 'DEACTIVATED'],
  DEACTIVATED: [],
};
export function assertTransition(from: SocietyStatus, to: SocietyStatus): void {
  if (!transitions[from].includes(to))
    throw new ApiError(409, 'INVALID_TRANSITION', 'This lifecycle transition is not allowed.');
}
export function assertEditable(status: SocietyStatus): void {
  if (status !== 'SETUP_IN_PROGRESS')
    throw new ApiError(409, 'SETUP_LOCKED', 'Setup changes require an in-progress society.');
}
export interface Requirements {
  committee: boolean;
  buildings: boolean;
  flats: boolean;
  residents: boolean;
  maintenance: boolean;
}
export function assertComplete(requirements: Requirements): void {
  if (Object.values(requirements).some((v) => !v))
    throw new ApiError(
      409,
      'SETUP_INCOMPLETE',
      'Complete committee, buildings/flats, residents review and maintenance setup first.',
    );
}
/** At most this many numbers are named in a message; the rest are summarised as "and N more". */
const listedLimit = 10;
function listed(values: string[]): string {
  const shown = values.slice(0, listedLimit);
  const rest = values.length - shown.length;
  const text =
    shown.length > 1 ? shown.slice(0, -1).join(', ') + ' and ' + shown.at(-1) : (shown[0] ?? '');
  return rest > 0 ? shown.join(', ') + ' and ' + rest + ' more' : text;
}
/** Numbers added to a wing or the row-house group, and those skipped because they exist. */
export interface AddedNumbers {
  added: string[];
  skipped: string[];
}
export interface WingResult extends AddedNumbers {
  code: string;
  /** True when the flats were added to a wing that already existed. */
  existing: boolean;
}
/** Comparison key mirroring the schema's case-insensitive flat-number collation. */
export const numberKey = (value: string): string => value.toLocaleLowerCase('en-US');
export function nothingToAddMessage(wing: string | null, skipped: string[]): string {
  const where = wing === null ? '' : ' in wing ' + wing;
  const kind = wing === null ? 'row house' : 'flat';
  return (
    (skipped.length === 1
      ? 'This ' + kind + ' already exists'
      : 'All of these ' + kind + 's already exist') +
    where +
    ' (' +
    listed(skipped) +
    '). Nothing new to save. Enter numbers that are not added yet.'
  );
}
/** A save with nothing new must not advance the revision or write history. */
export function assertSomethingAdded(wings: WingResult[]): void {
  if (wings.some((wing) => wing.added.length)) return;
  const skipped = wings.flatMap((wing) => wing.skipped);
  throw new ApiError(
    409,
    'NOTHING_TO_ADD',
    wings.length === 1
      ? nothingToAddMessage(wings[0]?.code ?? '', skipped)
      : 'Every flat in the selected wings already exists. Nothing new to save. Enter numbers that are not added yet.',
  );
}
export function archivedWingMessage(code: string): string {
  return (
    'Wing ' + code + ' was archived, so new flats cannot be added to it. Use a different wing code.'
  );
}
