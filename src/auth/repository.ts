import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { RuntimeDatabase } from '../database/runtime.js';
import { roleCapabilities, tenantRoles, permissions } from './types.js';
import type { AuthIdentity, Membership, Session, RequestAudit } from './types.js';

export interface UserRow extends RowDataPacket {
  id: string;
  email_normalized: string;
  password_hash: string | null;
  status: string;
}
interface SessionRow extends RowDataPacket {
  token_hash: Buffer;
  user_id: string | null;
  society_id: string | null;
  absolute_expires_at: string;
}
interface MembershipRow extends RowDataPacket {
  society_id: string;
  membership_id: string;
  name: string;
  role_code: string;
  permission_code: string | null;
}
export const sqlTime = (now: number): string =>
  new Date(now).toISOString().replace('T', ' ').replace('Z', '');
export class AuthRepository {
  constructor(readonly database: RuntimeDatabase) {}
  async user(email: string): Promise<UserRow | undefined> {
    return (
      await this.database.rows<UserRow>(
        'SELECT id, email_normalized, password_hash, status FROM users WHERE email_normalized = ?',
        [email],
      )
    )[0];
  }
  async audit(
    db: PoolConnection,
    action: string,
    userId: string | null,
    audit: RequestAudit,
    now: number,
  ): Promise<void> {
    await db.execute(
      'INSERT INTO auth_events (action, user_id, request_id, ip_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      [action, userId, audit.requestId, audit.ipHash, sqlTime(now)],
    );
  }
  async session(hash: Buffer, now: number, idleMs: number): Promise<Session | null> {
    return this.database.transaction(async (db) => {
      const [rows] = await db.execute<SessionRow[]>(
        'SELECT token_hash, user_id, society_id, absolute_expires_at FROM auth_sessions WHERE token_hash = ? AND revoked_at IS NULL AND idle_expires_at > ? AND absolute_expires_at > ? FOR UPDATE',
        [hash, sqlTime(now), sqlTime(now)],
      );
      const row = rows[0];
      if (!row) return null;
      await db.execute(
        'UPDATE auth_sessions SET idle_expires_at = LEAST(?, absolute_expires_at) WHERE token_hash = ?',
        [sqlTime(now + idleMs), hash],
      );
      return {
        hash: row.token_hash,
        userId: row.user_id,
        societyId: row.society_id,
        absoluteExpiresAt: row.absolute_expires_at,
      };
    });
  }
  async createSession(
    db: PoolConnection,
    hash: Buffer,
    userId: string | null,
    now: number,
    idleMs: number,
    absoluteMs: number,
  ): Promise<void> {
    await db.execute(
      'INSERT INTO auth_sessions (token_hash, user_id, created_at, idle_expires_at, absolute_expires_at) VALUES (?, ?, ?, ?, ?)',
      [hash, userId, sqlTime(now), sqlTime(now + idleMs), sqlTime(now + absoluteMs)],
    );
  }
  async identity(session: Session): Promise<AuthIdentity | null> {
    if (!session.userId) return null;
    const users = await this.database.rows<UserRow>(
      "SELECT id, email_normalized, password_hash, status FROM users WHERE id = ? AND status = 'ACTIVE'",
      [session.userId],
    );
    const user = users[0];
    if (!user) return null;
    const memberships = await this.memberships(user.id);
    const platform = await this.database.rows<RowDataPacket>(
      "SELECT user_id FROM platform_user_roles WHERE user_id = ? AND role_code = 'PLATFORM_ADMIN'",
      [user.id],
    );
    return {
      userId: user.id,
      email: user.email_normalized,
      platformAdmin: platform.length > 0,
      memberships,
      activeSociety: memberships.find((m) => m.societyId === session.societyId) ?? null,
    };
  }
  async memberships(userId: string): Promise<Membership[]> {
    const rows = await this.database.rows<MembershipRow>(
      `SELECT m.society_id, m.id AS membership_id, s.name, r.code AS role_code, p.code AS permission_code
      FROM society_memberships m JOIN users u ON u.id = m.user_id AND u.status = 'ACTIVE'
      JOIN societies s ON s.id = m.society_id AND s.status = 'ACTIVE' AND s.archived_at IS NULL
      JOIN society_persons sp ON sp.society_id = m.society_id AND sp.person_id = u.person_id AND sp.archived_at IS NULL
      JOIN membership_roles mr ON mr.society_id = m.society_id AND mr.membership_id = m.id
      JOIN roles r ON r.society_id = mr.society_id AND r.id = mr.role_id AND r.archived_at IS NULL
      LEFT JOIN role_permissions rp ON rp.society_id = r.society_id AND rp.role_id = r.id
      LEFT JOIN permissions p ON p.id = rp.permission_id
      WHERE m.user_id = ? AND m.status = 'ACTIVE' AND m.joined_at IS NOT NULL AND m.joined_at <= UTC_TIMESTAMP(6) AND m.ended_at IS NULL`,
      [userId],
    );
    const result = new Map<string, Membership>();
    for (const row of rows) {
      const role = tenantRoles.find((r) => r === row.role_code);
      if (!role) continue;
      let membership = result.get(row.society_id);
      if (!membership) {
        membership = {
          societyId: row.society_id,
          membershipId: row.membership_id,
          name: row.name,
          roles: [],
          permissions: [],
        };
        result.set(row.society_id, membership);
      }
      if (!membership.roles.includes(role)) membership.roles.push(role);
      const permission = permissions.find((p) => p === row.permission_code);
      if (
        permission &&
        roleCapabilities[role].includes(permission) &&
        !membership.permissions.includes(permission)
      )
        membership.permissions.push(permission);
    }
    return [...result.values()];
  }
  async revoke(hash: Buffer, now: number): Promise<void> {
    await this.database.connection(async (db) => {
      await db.execute(
        'UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
        [sqlTime(now), hash],
      );
    });
  }
  async rate(bucket: Buffer, expiry: number, limit: number): Promise<boolean> {
    return this.database.transaction(async (db) => {
      await db.execute(
        'INSERT INTO auth_rate_limits (bucket_hash, attempts, expires_at) VALUES (?, 1, ?) ON DUPLICATE KEY UPDATE attempts = attempts + 1',
        [bucket, sqlTime(expiry)],
      );
      const [rows] = await db.execute<RowDataPacket[]>(
        'SELECT attempts FROM auth_rate_limits WHERE bucket_hash = ?',
        [bucket],
      );
      return Number(rows[0]?.['attempts']) <= limit;
    });
  }
  async maintenance(now: number): Promise<void> {
    await this.database.connection(async (db) => {
      await db.execute('DELETE FROM auth_rate_limits WHERE expires_at <= ? LIMIT 1000', [
        sqlTime(now),
      ]);
      await db.execute('DELETE FROM auth_sessions WHERE absolute_expires_at <= ? LIMIT 1000', [
        sqlTime(now - 86_400_000),
      ]);
      await db.execute('DELETE FROM password_reset_tokens WHERE expires_at <= ? LIMIT 1000', [
        sqlTime(now - 86_400_000),
      ]);
    });
  }
  async selectSociety(
    session: Session,
    societyId: string | null,
    audit: RequestAudit,
    now: number,
  ): Promise<boolean> {
    return this.database.transaction(async (db) => {
      const [update] = await db.execute<ResultSetHeader>(
        'UPDATE auth_sessions SET society_id = ? WHERE token_hash = ? AND user_id = ? AND revoked_at IS NULL AND idle_expires_at > ? AND absolute_expires_at > ?',
        [societyId, session.hash, session.userId, sqlTime(now), sqlTime(now)],
      );
      if (update.affectedRows !== 1) return false;
      await this.audit(db, 'context.selected', session.userId, audit, now);
      return true;
    });
  }
}
