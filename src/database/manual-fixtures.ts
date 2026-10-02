import type { Connection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { hashPassword } from '../auth/crypto.js';
import { permissions, tenantRoles, roleCapabilities } from '../auth/types.js';
import type { TenantRole } from '../auth/types.js';

interface FixtureAccount {
  email: string;
  status: 'ACTIVE' | 'DISABLED' | 'PENDING';
  platform: boolean;
  memberships: readonly [number, TenantRole][];
}
export const manualAccounts: readonly FixtureAccount[] = [
  { email: 'platform@example.invalid', status: 'ACTIVE', platform: true, memberships: [] },
  {
    email: 'admin@example.invalid',
    status: 'ACTIVE',
    platform: false,
    memberships: [[0, 'COMMITTEE_ADMIN']],
  },
  {
    email: 'member@example.invalid',
    status: 'ACTIVE',
    platform: false,
    memberships: [[0, 'COMMITTEE_MEMBER']],
  },
  {
    email: 'accountant@example.invalid',
    status: 'ACTIVE',
    platform: false,
    memberships: [[0, 'ACCOUNTANT']],
  },
  {
    email: 'resident@example.invalid',
    status: 'ACTIVE',
    platform: false,
    memberships: [[0, 'RESIDENT']],
  },
  {
    email: 'multi@example.invalid',
    status: 'ACTIVE',
    platform: false,
    memberships: [
      [0, 'COMMITTEE_ADMIN'],
      [1, 'RESIDENT'],
    ],
  },
  { email: 'disabled@example.invalid', status: 'DISABLED', platform: false, memberships: [] },
  { email: 'pending@example.invalid', status: 'PENDING', platform: false, memberships: [] },
];
async function insert(db: Connection, sql: string, values: string[] = []): Promise<string> {
  const [result] = await db.execute<ResultSetHeader>(sql, values);
  if (!Number.isSafeInteger(result.insertId) || result.insertId <= 0)
    throw new Error('Unsafe fixture identifier.');
  return String(result.insertId);
}

export async function seedManualFixtures(db: Connection, password: string): Promise<void> {
  // Provisioner calls this only on its new, isolated, empty loopback schema.
  const [existing] = await db.query<RowDataPacket[]>('SELECT id FROM users LIMIT 1');
  if (existing.length) throw new Error('Manual fixtures refuse existing accounts.');
  const encoded = await hashPassword(password);
  await db.beginTransaction();
  try {
    for (const permission of permissions)
      await db.execute('INSERT INTO permissions (code, description) VALUES (?, ?)', [
        permission,
        permission,
      ]);
    const societies: string[] = [];
    const roles = new Map<string, string>();
    for (const [code, name] of [
      ['MANUAL_GREEN', 'Green Meadows (local demo)'],
      ['MANUAL_BLUE', 'Blue Heights (local demo)'],
    ]) {
      if (!code || !name) throw new Error('Missing fixture society.');
      const society = await insert(
        db,
        "INSERT INTO societies (code, name, status) VALUES (?, ?, 'ACTIVE')",
        [code, name],
      );
      societies.push(society);
      for (const role of tenantRoles) {
        const id = await insert(db, 'INSERT INTO roles (society_id, code, name) VALUES (?, ?, ?)', [
          society,
          role,
          role,
        ]);
        roles.set(society + ':' + role, id);
        for (const permission of roleCapabilities[role])
          await db.execute(
            'INSERT INTO role_permissions (society_id, role_id, permission_id) SELECT ?, ?, id FROM permissions WHERE code = ?',
            [society, id, permission],
          );
      }
    }
    for (const account of manualAccounts) {
      const person = await insert(db, 'INSERT INTO persons () VALUES ()');
      const user = await insert(
        db,
        'INSERT INTO users (person_id, email_normalized, password_hash, status) VALUES (?, ?, ?, ?)',
        [person, account.email, encoded, account.status],
      );
      if (account.platform)
        await db.execute(
          "INSERT INTO platform_user_roles (user_id, role_code) VALUES (?, 'PLATFORM_ADMIN')",
          [user],
        );
      for (const [index, role] of account.memberships) {
        const society = societies[index];
        const roleId = society ? roles.get(society + ':' + role) : undefined;
        if (!society || !roleId) throw new Error('Missing fixture role.');
        await db.execute(
          'INSERT INTO society_persons (society_id, person_id, display_name) VALUES (?, ?, ?)',
          [society, person, account.email],
        );
        const membership = await insert(
          db,
          "INSERT INTO society_memberships (society_id, user_id, status, joined_at) VALUES (?, ?, 'ACTIVE', UTC_TIMESTAMP(6))",
          [society, user],
        );
        await db.execute(
          'INSERT INTO membership_roles (society_id, membership_id, role_id) VALUES (?, ?, ?)',
          [society, membership, roleId],
        );
      }
    }
    const society = societies[0];
    if (!society) throw new Error('Missing fixture society.');
    const building = await insert(
      db,
      "INSERT INTO buildings (society_id, code, name) VALUES (?, 'A', 'Demo building A')",
      [society],
    );
    const flat = await insert(
      db,
      "INSERT INTO flats (society_id, building_id, flat_number, area_sq_ft) VALUES (?, ?, '101', '900.00')",
      [society, building],
    );
    for (const [name, type, start, end] of [
      ['Demo owner without login', 'OWNER', '2024-01-01', null],
      ['Demo current tenant without login', 'TENANT', '2025-01-01', null],
      ['Demo previous tenant without login', 'TENANT', '2024-01-01', '2024-12-31'],
    ] as const) {
      const person = await insert(db, 'INSERT INTO persons () VALUES ()');
      await db.execute(
        'INSERT INTO society_persons (society_id, person_id, display_name) VALUES (?, ?, ?)',
        [society, person, name],
      );
      await db.execute(
        'INSERT INTO flat_occupancies (society_id, flat_id, person_id, occupancy_type, starts_on, ends_on) VALUES (?, ?, ?, ?, ?, ?)',
        [society, flat, person, type, start, end],
      );
    }
    await db.commit();
  } catch (error) {
    await db.rollback();
    throw error;
  }
}
