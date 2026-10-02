import type { RowDataPacket } from 'mysql2/promise';
import type { AuthService } from '../auth/service.js';
import type { RequestAudit } from '../auth/types.js';
import type { ResetQueue } from '../auth/reset-queue.js';
import { newToken, tokenHash, hashPassword } from '../auth/crypto.js';
import { sqlTime } from '../auth/repository.js';
import { insert, rows } from '../onboarding/repository.js';
import { unavailable } from './identity.js';
export interface ResidentMailer {
  verification(email: string, link: string): Promise<void>;
  existingAccount(email: string, link: string): Promise<void>;
  invitation(email: string, link: string, society: string): Promise<void>;
}
interface VerificationRow extends RowDataPacket {
  email_normalized: string | null;
  password_hash: string | null;
  display_name: string | null;
}
export class ResidentAccounts {
  constructor(
    readonly auth: AuthService,
    readonly origin: string,
    readonly mailer: ResidentMailer,
    readonly queue: ResetQueue,
  ) {}
  start(
    input: { email: string; password: string; displayName: string },
    audit: RequestAudit,
  ): void {
    // Account lookup, Argon2 and SMTP all run off the public response path.
    this.queue.enqueue(async () => {
      if (await this.auth.repository.user(input.email)) {
        await this.mailer.existingAccount(input.email, this.origin + '/login');
        return;
      }
      const encoded = await hashPassword(input.password),
        token = newToken(),
        now = this.auth.clock();
      await this.auth.repository.database.transaction(async (db) => {
        await db.execute(
          'UPDATE resident_account_verifications SET email_normalized=NULL,display_name=NULL,password_hash=NULL WHERE email_normalized=? AND consumed_at IS NULL',
          [input.email],
        );
        await db.execute(
          'INSERT INTO resident_account_verifications(token_hash,email_normalized,display_name,password_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)',
          [
            tokenHash(token),
            input.email,
            input.displayName,
            encoded,
            sqlTime(now + 1800000),
            sqlTime(now),
          ],
        );
      });
      await this.mailer.verification(
        input.email,
        this.origin + '/verify-resident-email#token=' + token,
      );
    }, audit.requestId);
  }
  async verify(token: string, audit: RequestAudit): Promise<void> {
    await this.auth.repository.database.transaction(async (db) => {
      const v = (
        await rows<VerificationRow>(
          db,
          'SELECT email_normalized,password_hash,display_name FROM resident_account_verifications WHERE token_hash=? AND consumed_at IS NULL AND expires_at>? FOR UPDATE',
          [tokenHash(token), sqlTime(this.auth.clock())],
        )
      )[0];
      if (!v?.email_normalized || !v.password_hash || !v.display_name) throw unavailable();
      if (
        (
          await rows(db, 'SELECT id FROM users WHERE email_normalized=? FOR UPDATE', [
            v.email_normalized,
          ])
        ).length
      )
        throw unavailable();
      const person = await insert(db, 'INSERT INTO persons() VALUES()');
      const user = await insert(
        db,
        "INSERT INTO users(person_id,email_normalized,password_hash,status,email_verified_at) VALUES(?,?,?,'ACTIVE',?)",
        [person, v.email_normalized, v.password_hash, sqlTime(this.auth.clock())],
      );
      await db.execute(
        'UPDATE resident_account_verifications SET consumed_at=?,email_normalized=NULL,display_name=NULL,password_hash=NULL WHERE token_hash=?',
        [sqlTime(this.auth.clock()), tokenHash(token)],
      );
      await db.execute(
        "INSERT INTO resident_account_events(user_id,action,request_id,ip_hash,created_at) VALUES(?,'ACCOUNT_VERIFIED',?,?,?)",
        [user, audit.requestId, audit.ipHash, sqlTime(this.auth.clock())],
      );
    });
  }
  async expire(): Promise<void> {
    await this.auth.repository.database.connection(async (db) => {
      await db.execute(
        'UPDATE resident_account_verifications SET email_normalized=NULL,display_name=NULL,password_hash=NULL WHERE expires_at<=? AND email_normalized IS NOT NULL LIMIT 1000',
        [sqlTime(this.auth.clock())],
      );
    });
  }
}
