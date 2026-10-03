export const tenantRoles = [
  'COMMITTEE_ADMIN',
  'COMMITTEE_MEMBER',
  'ACCOUNTANT',
  'RESIDENT',
] as const;
export type TenantRole = (typeof tenantRoles)[number];
export const permissions = [
  'society.dashboard.read',
  'society.finance.read',
  'society.finance.record',
  'society.finance.configure',
  'society.finance.generate',
  'society.finance.discount',
  'society.finance.reverse',
  'society.members.manage',
  'society.notices.manage',
  'society.complaints.manage',
] as const;
export type Permission = (typeof permissions)[number];
export const roleCapabilities: Record<TenantRole, readonly Permission[]> = {
  COMMITTEE_ADMIN: permissions,
  COMMITTEE_MEMBER: [
    'society.dashboard.read',
    'society.notices.manage',
    'society.complaints.manage',
  ],
  ACCOUNTANT: [
    'society.dashboard.read',
    'society.finance.read',
    'society.finance.record',
    'society.finance.generate',
  ],
  RESIDENT: ['society.dashboard.read'],
};
export interface Membership {
  societyId: string;
  membershipId: string;
  name: string;
  roles: TenantRole[];
  permissions: Permission[];
}
export interface AuthIdentity {
  userId: string;
  email: string;
  platformAdmin: boolean;
  memberships: Membership[];
  activeSociety: Membership | null;
  setupSocieties?: { societyId: string; name: string; status: string }[];
}
export interface Session {
  hash: Buffer;
  userId: string | null;
  societyId: string | null;
  absoluteExpiresAt: string;
}
export interface RequestAudit {
  requestId: string;
  ipHash: Buffer;
}
