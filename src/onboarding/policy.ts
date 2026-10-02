import { ApiError } from '../http/errors.js';
import type { SocietyStatus } from './contracts.js';
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
