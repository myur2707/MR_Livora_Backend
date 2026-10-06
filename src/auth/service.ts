import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { AuthConfig } from './config.js';
import {
  csrfToken,
  hashPassword,
  keyedHash,
  newToken,
  tokenHash,
  verifyPassword,
} from './crypto.js';
import { sqlTime } from './repository.js';
import type { AuthRepository } from './repository.js';
import type { UserRow } from './repository.js';
import type { AccountProfile } from './repository.js';
import type { ResetMailer } from './mailer.js';
import type { ResetQueue } from './reset-queue.js';
import type { RequestAudit, Session } from './types.js';
import { ApiError } from '../http/errors.js';

interface ResetRow extends RowDataPacket {
  user_id: string;
}
export class AuthService {
  private constructor(
    readonly repository: AuthRepository,
    readonly config: AuthConfig,
    readonly mailer: ResetMailer,
    readonly queue: ResetQueue,
    readonly clock: () => number,
    private readonly dummyHash: string,
  ) {}
  static async create(
    repository: AuthRepository,
    config: AuthConfig,
    mailer: ResetMailer,
    queue: ResetQueue,
    clock: () => number = Date.now,
  ): Promise<AuthService> {
    return new AuthService(
      repository,
      config,
      mailer,
      queue,
      clock,
      await hashPassword(newToken()),
    );
  }
  csrf(token: string): string {
    return csrfToken(this.config.secret, token);
  }
  audit(ip: string, requestId: string): RequestAudit {
    return { requestId, ipHash: keyedHash(this.config.secret, 'ip:' + ip) };
  }
  async rate(scope: string, key: string, limit: number, windowMs: number): Promise<void> {
    const window = Math.floor(this.clock() / windowMs);
    const expiresAt = (window + 1) * windowMs;
    const allowed = await this.repository.rate(
      keyedHash(this.config.secret, scope + ':' + window + ':' + key),
      expiresAt,
      limit,
    );
    if (!allowed)
      throw new ApiError(
        429,
        'RATE_LIMITED',
        'Too many requests. Try again later.',
        Math.max(1, Math.ceil((expiresAt - this.clock()) / 1000)),
      );
  }
  async readSession(token: string): Promise<Session | null> {
    return this.repository.session(tokenHash(token), this.clock(), this.config.idleMs);
  }
  async anonymous(): Promise<string> {
    const token = newToken();
    const now = this.clock();
    await this.repository.database.connection((db) =>
      this.repository.createSession(
        db,
        tokenHash(token),
        null,
        now,
        this.config.idleMs,
        this.config.idleMs,
      ),
    );
    return token;
  }
  async login(
    session: Session,
    email: string,
    password: string,
    audit: RequestAudit,
  ): Promise<string> {
    const user = await this.repository.user(email);
    const valid = await verifyPassword(user?.password_hash ?? this.dummyHash, password);
    if (!valid || !user || user.status !== 'ACTIVE' || !user.password_hash) {
      await this.repository.database.connection((db) =>
        this.repository.audit(db, 'login.failed', null, audit, this.clock()),
      );
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    }
    const token = newToken();
    await this.repository.database.transaction(async (db) => {
      // Recheck under the same account lock used by reset, preventing a stale-password login race.
      const [rows] = await db.execute<UserRow[]>(
        'SELECT id, email_normalized, password_hash, status FROM users WHERE id = ? FOR UPDATE',
        [user.id],
      );
      if (rows[0]?.status !== 'ACTIVE' || rows[0].password_hash !== user.password_hash)
        throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
      const now = this.clock();
      const [revoked] = await db.execute<ResultSetHeader>(
        'UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL AND idle_expires_at > ? AND absolute_expires_at > ?',
        [sqlTime(now), session.hash, sqlTime(now), sqlTime(now)],
      );
      if (revoked.affectedRows !== 1)
        throw new ApiError(403, 'CSRF_INVALID', 'Refresh this page and try again.');
      await this.repository.createSession(
        db,
        tokenHash(token),
        user.id,
        now,
        this.config.idleMs,
        this.config.absoluteMs,
      );
      await this.repository.audit(db, 'login.succeeded', user.id, audit, now);
    });
    return token;
  }
  async logout(session: Session, audit: RequestAudit): Promise<void> {
    await this.repository.database.transaction(async (db) => {
      await db.execute(
        'UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
        [sqlTime(this.clock()), session.hash],
      );
      await this.repository.audit(db, 'logout', session.userId, audit, this.clock());
    });
  }
  async profile(session: Session): Promise<AccountProfile> {
    if (!session.userId) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    const profile = await this.repository.profile(session.userId);
    if (!profile) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    return profile;
  }
  async updateProfile(
    session: Session,
    input: { displayName: string; contactPhone: string | null },
    audit: RequestAudit,
  ): Promise<AccountProfile> {
    if (!session.userId) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    const profile = await this.repository.updateProfile(
      session.userId,
      input.displayName,
      input.contactPhone,
      audit,
      this.clock(),
    );
    if (!profile) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    return profile;
  }
  requestReset(email: string, audit: RequestAudit): void {
    this.queue.enqueue(async () => {
      const token = newToken();
      const user = await this.repository.user(email);
      if (!user || user.status !== 'ACTIVE' || !user.password_hash) return;
      const created = await this.repository.database.transaction(async (db) => {
        const [rows] = await db.execute<UserRow[]>(
          'SELECT id, email_normalized, password_hash, status FROM users WHERE id = ? FOR UPDATE',
          [user.id],
        );
        if (rows[0]?.status !== 'ACTIVE') return false;
        const now = this.clock();
        await db.execute(
          'UPDATE password_reset_tokens SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL',
          [sqlTime(now), user.id],
        );
        await db.execute(
          'INSERT INTO password_reset_tokens (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
          [tokenHash(token), user.id, sqlTime(now), sqlTime(now + this.config.resetMs)],
        );
        await this.repository.audit(db, 'password.reset.requested', user.id, audit, now);
        return true;
      });
      if (created) {
        try {
          await this.mailer.send(email, this.config.origin + '/reset-password#token=' + token);
        } catch {
          await this.repository.database.connection((db) =>
            this.repository.audit(db, 'mail.delivery.failed', user.id, audit, this.clock()),
          );
          throw new Error('Reset delivery failed');
        }
      }
    }, audit.requestId);
  }
  async resetPassword(token: string, password: string, audit: RequestAudit): Promise<void> {
    const hash = tokenHash(token);
    const candidate = (
      await this.repository.database.rows<ResetRow>(
        'SELECT user_id FROM password_reset_tokens WHERE token_hash = ?',
        [hash],
      )
    )[0];
    const invalid = (): ApiError =>
      new ApiError(
        400,
        'RESET_INVALID',
        'This reset link is invalid or expired. Request a new link.',
      );
    if (!candidate) throw invalid();
    const encoded = await hashPassword(password);
    await this.repository.database.transaction(async (db) => {
      const [users] = await db.execute<UserRow[]>(
        'SELECT id, email_normalized, password_hash, status FROM users WHERE id = ? FOR UPDATE',
        [candidate.user_id],
      );
      const now = this.clock();
      const [tokens] = await db.execute<ResetRow[]>(
        'SELECT user_id FROM password_reset_tokens WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ? FOR UPDATE',
        [hash, sqlTime(now)],
      );
      if (!tokens[0] || users[0]?.status !== 'ACTIVE') throw invalid();
      await db.execute('UPDATE users SET password_hash = ? WHERE id = ?', [
        encoded,
        candidate.user_id,
      ]);
      await db.execute(
        'UPDATE password_reset_tokens SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL',
        [sqlTime(now), candidate.user_id],
      );
      await db.execute(
        'UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
        [sqlTime(now), candidate.user_id],
      );
      await this.repository.audit(db, 'password.reset.completed', candidate.user_id, audit, now);
    });
  }
}
