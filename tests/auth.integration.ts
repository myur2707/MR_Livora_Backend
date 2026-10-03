import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { TestContext } from 'node:test';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { openRuntime } from '../src/database/runtime.js';
import { AuthRepository, sqlTime } from '../src/auth/repository.js';
import { AuthService } from '../src/auth/service.js';
import { ResetQueue } from '../src/auth/reset-queue.js';
import { hashPassword, tokenHash } from '../src/auth/crypto.js';
import { createApp } from '../src/http/app.js';
import { Security } from '../src/http/security.js';
import express from 'express';
import { ApiError, errorHandler } from '../src/http/errors.js';
import { createFixture, insert } from './fixtures.js';
import { AuthClient } from './auth-client.js';
import { grantTestRuntime } from './runtime-provision.js';
interface FlatRow extends RowDataPacket {
  id: string;
}

export async function authIntegration(suite: TestContext, db: Connection): Promise<void> {
  const password = 'Synthetic auth test password';
  const encoded = await hashPassword(password);
  async function account(
    email: string,
    status = 'ACTIVE',
  ): Promise<{ user: number; person: number }> {
    const person = await insert(db, 'INSERT INTO persons () VALUES ()');
    const user = await insert(
      db,
      'INSERT INTO users (person_id, email_normalized, password_hash, status) VALUES (?, ?, ?, ?)',
      [person, email, encoded, status],
    );
    return { user, person };
  }
  const user = await account('auth@example.invalid');
  const platform = await account('platform@example.invalid');
  await account('disabled@example.invalid', 'DISABLED');
  await account('pending@example.invalid', 'PENDING');
  await db.execute(
    "INSERT INTO platform_user_roles (user_id, role_code) VALUES (?, 'PLATFORM_ADMIN')",
    [platform.user],
  );
  const a = await createFixture(db, 'AUTH_A', user.user, user.person, 'COMMITTEE_ADMIN');
  const b = await createFixture(db, 'AUTH_B', user.user, user.person, 'RESIDENT');
  const c = await createFixture(db, 'AUTH_C', platform.user, platform.person, 'ACCOUNTANT');
  await db.execute("UPDATE societies SET status = 'ACTIVE' WHERE id IN (?, ?, ?)", [
    a.society,
    b.society,
    c.society,
  ]);
  const permission = await insert(
    db,
    "INSERT INTO permissions (code, description) VALUES ('society.dashboard.read', 'Dashboard authorization')",
  );
  const finance = await insert(
    db,
    "INSERT INTO permissions (code, description) VALUES ('society.finance.read', 'Finance authorization')",
  );
  for (const fixture of [a, b, c]) {
    await db.execute(
      'INSERT INTO role_permissions (society_id, role_id, permission_id) VALUES (?, ?, ?), (?, ?, ?)',
      [fixture.society, fixture.role, permission, fixture.society, fixture.role, finance],
    );
  }
  let now = Date.now();
  await grantTestRuntime();
  const database = await openRuntime(process.env);
  const repository = new AuthRepository(database);
  const mail: { email: string; link: string }[] = [];
  const safeLogs: string[] = [];
  const log = (code: string): void => {
    safeLogs.push(code);
  };
  const queue = new ResetQueue(log);
  const config = {
    origin: 'http://127.0.0.1:4200',
    secret: 'c'.repeat(64),
    secure: false,
    cookieName: 'livora_session',
    idleMs: 1_800_000,
    absoluteMs: 43_200_000,
    resetMs: 1_800_000,
  };
  const auth = await AuthService.create(
    repository,
    config,
    {
      send(email, link) {
        mail.push({ email, link });
        return Promise.resolve();
      },
    },
    queue,
    () => now,
  );
  const app = createApp(auth, log);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = 'http://127.0.0.1:' + address.port;
  const client = new AuthClient(base, config.origin);
  const tickWindow = (): void => {
    now += 900_001;
  };
  const fresh = (): AuthClient => new AuthClient(base, config.origin);
  try {
    await suite.test(
      'read requests reject unexpected origins and rate limits report their actual window',
      async () => {
        assert.equal(
          (
            await client.request('/auth/csrf', undefined, {
              Origin: 'http://other.example',
              'Sec-Fetch-Site': 'same-site',
            })
          ).status,
          403,
        );
        const noOrigin = await fetch(base + '/api/v1/auth/csrf');
        assert.equal(noOrigin.status, 200);
        assert.equal(noOrigin.headers.get('Access-Control-Allow-Origin'), null);
        assert.equal((await client.request('/auth/csrf?role=PLATFORM_ADMIN')).status, 400);
        const saved = now;
        now = Math.floor(now / 60000) * 60000 + 59000;
        await auth.rate('step12-window', 'synthetic-actor', 1, 60000);
        await assert.rejects(
          auth.rate('step12-window', 'synthetic-actor', 1, 60000),
          (error: unknown) =>
            error instanceof ApiError && error.status === 429 && error.retryAfterSeconds === 1,
        );
        now += 1000;
        await auth.rate('step12-window', 'synthetic-actor', 1, 60000);
        now = saved;
      },
    );
    await suite.test(
      'runtime account cannot perform DDL, grant roles, rewrite money, delete bills or modify audits',
      async () => {
        for (const sql of [
          'CREATE TABLE unauthorized_runtime_table (id INT)',
          'UPDATE payments SET amount=amount WHERE 1=0',
          'UPDATE bills SET total_amount=total_amount WHERE 1=0',
          'DELETE FROM bills WHERE 1=0',
          'UPDATE audit_logs SET action=action WHERE 1=0',
          'DELETE FROM audit_logs WHERE 1=0',
          'DELETE FROM platform_user_roles',
          'UPDATE users SET status = status',
          'SELECT * FROM auth_events',
        ]) {
          await assert.rejects(database.connection((connection) => connection.query(sql)));
        }
      },
    );
    await suite.test(
      'anonymous requests and forged user/role/tenant fields cannot authenticate',
      async () => {
        assert.equal((await client.request('/auth/session')).status, 401);
        await client.bootstrap();
        const invalid = await client.request('/auth/login', {
          email: 'auth@example.invalid',
          password,
          user_id: String(platform.user),
          role: 'PLATFORM_ADMIN',
          society_id: String(c.society),
        });
        assert.equal(invalid.status, 400);
        assert.equal(
          (
            await client.request('/auth/session', undefined, {
              'x-user-id': String(user.user),
              'x-role': 'PLATFORM_ADMIN',
            })
          ).status,
          401,
        );
      },
    );
    await suite.test(
      'CSRF covers login, forgot, reset, logout and society changes; origins are exact',
      async () => {
        for (const path of [
          '/auth/login',
          '/auth/logout',
          '/auth/forgot-password',
          '/auth/reset-password',
          '/auth/society-context',
        ]) {
          assert.equal((await client.request(path, {}, { 'X-CSRF-Token': '' })).status, 403);
          assert.equal(
            (await client.request(path, {}, { Origin: 'https://evil.example' })).status,
            403,
          );
        }
        const other = fresh();
        await other.bootstrap();
        assert.equal(
          (
            await other.request(
              '/auth/login',
              { email: 'auth@example.invalid', password },
              { 'X-CSRF-Token': client.csrf },
            )
          ).status,
          403,
        );
      },
    );
    await suite.test(
      'missing, disabled, pending and incorrect-password accounts return the same safe error',
      async () => {
        const failures: Record<string, unknown>[] = [];
        for (const email of [
          'missing@example.invalid',
          'disabled@example.invalid',
          'pending@example.invalid',
          'auth@example.invalid',
        ]) {
          const result = await client.request('/auth/login', {
            email,
            password: email === 'auth@example.invalid' ? 'incorrect password' : password,
          });
          assert.equal(result.status, 401);
          const error = result.data['error'];
          assert.ok(typeof error === 'object' && error !== null && 'requestId' in error);
          const { requestId, ...safe } = error;
          assert.equal(typeof requestId, 'string');
          failures.push(safe);
        }
        assert.ok(failures.every((f) => JSON.stringify(f) === JSON.stringify(failures[0])));
      },
    );
    await suite.test(
      'successful login rotates the anonymous session and stores only hashes',
      async () => {
        const anonymous = client.cookie;
        const oldCsrf = client.csrf;
        assert.equal(
          (await client.request('/auth/login', { email: ' AUTH@EXAMPLE.INVALID ', password }))
            .status,
          200,
        );
        assert.notEqual(client.cookie, anonymous);
        assert.notEqual(client.csrf, oldCsrf);
        const replay = fresh();
        replay.cookie = anonymous;
        assert.equal((await replay.request('/auth/session')).status, 401);
        const session = await client.request('/auth/session');
        assert.equal(session.status, 200);
        assert.equal(session.data['userId'], String(user.user));
        assert.equal(session.data['platformAdmin'], false);
        assert.equal(session.data['activeSociety'], null);
        assert.equal((session.data['memberships'] as unknown[]).length, 2);
        assert.equal((await client.request('/society/access')).status, 403);
      },
    );
    await suite.test(
      'two societies have different roles; unowned selection and forged identifiers are denied',
      async () => {
        assert.equal(
          (await client.request('/auth/society-context', { societyId: String(a.society) })).status,
          204,
        );
        assert.equal((await client.request('/society/access')).status, 200);
        assert.equal(
          (await client.request('/auth/society-context', { societyId: String(c.society) })).status,
          403,
        );
        assert.equal(
          (
            await client.request('/society/access', undefined, {
              'x-society-id': String(c.society),
            })
          ).data['societyId'],
          String(a.society),
        );
        assert.equal(
          (
            await client.request('/auth/society-context', {
              societyId: String(b.society),
              user_id: String(platform.user),
            })
          ).status,
          400,
        );
        assert.equal(
          (await client.request('/auth/society-context', { societyId: String(b.society) })).status,
          204,
        );
        const access = await client.request('/society/access');
        assert.deepEqual(access.data['roles'], ['RESIDENT']);
        assert.deepEqual(access.data['permissions'], ['society.dashboard.read']);
      },
    );
    await suite.test(
      'permission middleware and tenant-scoped SQL reject IDOR/BOLA for existing foreign flat IDs',
      async () => {
        // Exercise the production middleware on a test-owned probe; no business route is shipped.
        const security = new Security(auth);
        const probe = express();
        probe.get(
          '/api/v1/probe/:flatId',
          security.headers,
          security.load,
          security.authenticated,
          security.tenant('society.finance.read'),
          async (request, response) => {
            const flatId = request.params['flatId'];
            if (typeof flatId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(flatId))
              throw new ApiError(400, 'INVALID_REQUEST', 'Invalid identifier.');
            const societyId = security.identity(request).activeSociety?.societyId;
            assert.ok(societyId);
            const [rows] = await db.execute<FlatRow[]>(
              'SELECT id FROM flats WHERE society_id = ? AND id = ?',
              [societyId, flatId],
            );
            if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Resource not found.');
            response.json({ id: rows[0].id });
          },
        );
        probe.use(errorHandler(log));
        const listener = probe.listen(0, '127.0.0.1');
        await once(listener, 'listening');
        const port = listener.address();
        assert.ok(port && typeof port !== 'string');
        const browser = new AuthClient('http://127.0.0.1:' + port.port, config.origin);
        browser.cookie = client.cookie;
        try {
          assert.equal((await browser.request('/probe/' + b.flat)).status, 403);
          assert.equal(
            (await client.request('/auth/society-context', { societyId: String(a.society) }))
              .status,
            204,
          );
          assert.equal((await browser.request('/probe/' + a.flat)).status, 200);
          const foreign = await browser.request('/probe/' + b.flat, undefined, {
            'x-society-id': String(b.society),
            'x-user-id': String(platform.user),
          });
          assert.equal(foreign.status, 404);
          assert.equal((await browser.request('/probe/99999999')).status, 404);
          assert.deepEqual(Object.keys(foreign.data), ['error']);
        } finally {
          await new Promise<void>((resolve, reject) =>
            listener.close((error) => (error ? reject(error) : resolve())),
          );
          await client.request('/auth/society-context', { societyId: String(b.society) });
        }
      },
    );
    await suite.test(
      'platform admin has explicit platform scope without implicit tenant access',
      async () => {
        assert.equal((await client.request('/platform/access')).status, 403);
        const admin = fresh();
        await admin.login('platform@example.invalid', password);
        assert.equal((await admin.request('/platform/access')).status, 200);
        assert.equal((await admin.request('/society/access')).status, 403);
        assert.equal(
          (await admin.request('/auth/society-context', { societyId: String(a.society) })).status,
          403,
        );
        assert.equal(
          (await admin.request('/auth/society-context', { societyId: String(c.society) })).status,
          204,
        );
        assert.equal((await admin.request('/society/access')).status, 200);
      },
    );
    await suite.test(
      'membership, society, profile and permission revocations take effect on the next request',
      async () => {
        await db.execute("UPDATE society_memberships SET status = 'SUSPENDED' WHERE id = ?", [
          b.membership,
        ]);
        assert.equal((await client.request('/society/access')).status, 403);
        await db.execute("UPDATE society_memberships SET status = 'ACTIVE' WHERE id = ?", [
          b.membership,
        ]);
        await db.execute("UPDATE societies SET status = 'SUSPENDED' WHERE id = ?", [b.society]);
        assert.equal((await client.request('/society/access')).status, 403);
        await db.execute("UPDATE societies SET status = 'ACTIVE' WHERE id = ?", [b.society]);
        await db.execute(
          'UPDATE society_persons SET archived_at = UTC_TIMESTAMP(6) WHERE society_id = ? AND person_id = ?',
          [b.society, user.person],
        );
        assert.equal((await client.request('/society/access')).status, 403);
        await db.execute(
          'UPDATE society_persons SET archived_at = NULL WHERE society_id = ? AND person_id = ?',
          [b.society, user.person],
        );
        await db.execute(
          'DELETE FROM role_permissions WHERE society_id = ? AND permission_id = ?',
          [b.society, permission],
        );
        assert.equal((await client.request('/society/access')).status, 403);
        await db.execute(
          'INSERT INTO role_permissions (society_id, role_id, permission_id) VALUES (?, ?, ?)',
          [b.society, b.role, permission],
        );
        assert.equal((await client.request('/society/access')).status, 200);
      },
    );
    await suite.test(
      'disabled accounts invalidate existing sessions and reactivation cannot revive them',
      async () => {
        await db.execute("UPDATE users SET status = 'DISABLED' WHERE id = ?", [user.user]);
        assert.equal((await client.request('/auth/session')).status, 401);
        await db.execute("UPDATE users SET status = 'ACTIVE' WHERE id = ?", [user.user]);
        assert.equal((await client.request('/auth/session')).status, 401);
        tickWindow();
        await client.login('auth@example.invalid', password);
        const quickDisable = fresh();
        await quickDisable.login('auth@example.invalid', password);
        await db.execute("UPDATE users SET status = 'DISABLED' WHERE id = ?", [user.user]);
        await db.execute("UPDATE users SET status = 'ACTIVE' WHERE id = ?", [user.user]);
        assert.equal((await quickDisable.request('/auth/session')).status, 401);
        await client.login('auth@example.invalid', password);
      },
    );
    await suite.test(
      'idle expiry and absolute expiry cannot be extended beyond their bounds',
      async () => {
        const idle = fresh();
        await idle.login('auth@example.invalid', password);
        const idleHash = tokenHash(idle.cookie.split('=')[1] ?? '');
        await db.execute(
          'UPDATE auth_sessions SET created_at = ?, idle_expires_at = ? WHERE token_hash = ?',
          [sqlTime(now - 60_000), sqlTime(now - 1), idleHash],
        );
        assert.equal((await idle.request('/auth/session')).status, 401);
        const absolute = fresh();
        await absolute.login('auth@example.invalid', password);
        const hash = tokenHash(absolute.cookie.split('=')[1] ?? '');
        await db.execute(
          'UPDATE auth_sessions SET absolute_expires_at = ?, idle_expires_at = ? WHERE token_hash = ?',
          [sqlTime(now + 10), sqlTime(now + 10), hash],
        );
        now += 11;
        assert.equal((await absolute.request('/auth/session')).status, 401);
      },
    );
    await suite.test(
      'forgot password is enumeration-safe, does not disclose tokens, and never activates disabled/pending accounts',
      async () => {
        const results: string[] = [];
        for (const email of [
          'auth@example.invalid',
          'missing@example.invalid',
          'disabled@example.invalid',
          'pending@example.invalid',
        ]) {
          const result = await client.request('/auth/forgot-password', { email });
          assert.equal(result.status, 202);
          results.push(result.raw);
        }
        assert.ok(results.every((v) => v === results[0]));
        await queue.idle();
        assert.equal(mail.length, 1);
        assert.equal(mail[0]?.email, 'auth@example.invalid');
        assert.ok(mail[0]?.link.startsWith(config.origin + '/reset-password#token='));
      },
    );
    await suite.test(
      'expired reset tokens fail; replacement tokens are single-use under concurrency and revoke all sessions',
      async () => {
        const first = mail[0]?.link.split('token=')[1];
        assert.ok(first);
        assert.equal(
          (
            await client.request('/auth/reset-password', {
              token: first,
              password: 'Short password',
            })
          ).status,
          400,
        );
        await db.execute(
          'UPDATE password_reset_tokens SET created_at = ?, expires_at = ? WHERE token_hash = ?',
          [sqlTime(now - 60_000), sqlTime(now - 1), tokenHash(first)],
        );
        assert.equal(
          (
            await client.request('/auth/reset-password', {
              token: first,
              password: 'A changed synthetic password',
            })
          ).status,
          400,
        );
        await client.request('/auth/forgot-password', { email: 'auth@example.invalid' });
        await queue.idle();
        const value = mail.at(-1)?.link.split('token=')[1];
        assert.ok(value);
        const parallel = fresh();
        await parallel.bootstrap();
        const resetter = fresh();
        await resetter.bootstrap();
        const changes = await Promise.all([
          resetter.request('/auth/reset-password', {
            token: value,
            password: 'A changed synthetic password',
          }),
          parallel.request('/auth/reset-password', {
            token: value,
            password: 'A changed synthetic password',
          }),
        ]);
        assert.deepEqual(changes.map((v) => v.status).sort(), [204, 400]);
        await parallel.bootstrap();
        assert.equal(
          (
            await parallel.request('/auth/reset-password', {
              token: value,
              password: 'Another synthetic password',
            })
          ).status,
          400,
        );
        assert.equal((await client.request('/auth/session')).status, 401);
        tickWindow();
        await client.bootstrap();
        assert.equal(
          (await client.request('/auth/login', { email: 'auth@example.invalid', password })).status,
          401,
        );
        assert.equal(
          (
            await client.request('/auth/login', {
              email: 'auth@example.invalid',
              password: 'A changed synthetic password',
            })
          ).status,
          200,
        );
      },
    );
    await suite.test(
      'logout revokes copied cookies and clears HttpOnly SameSite cookies',
      async () => {
        const copied = fresh();
        copied.cookie = client.cookie;
        const result = await client.request('/auth/logout', {});
        assert.equal(result.status, 204);
        assert.match(result.headers.get('set-cookie') ?? '', /HttpOnly/);
        assert.match(result.headers.get('set-cookie') ?? '', /SameSite=Lax/);
        assert.equal((await copied.request('/auth/session')).status, 401);
      },
    );
    await suite.test(
      'account and IP rate limits persist across independent app instances and concurrent attempts',
      async () => {
        tickWindow();
        await client.bootstrap();
        const calls = await Promise.all(
          Array.from({ length: 7 }, () =>
            client.request('/auth/login', {
              email: 'limited@example.invalid',
              password: 'incorrect',
            }),
          ),
        );
        assert.equal(calls.filter((v) => v.status === 401).length, 5);
        assert.equal(calls.filter((v) => v.status === 429).length, 2);
        const independent = await AuthService.create(
          new AuthRepository(database),
          config,
          auth.mailer,
          queue,
          () => now,
        );
        await assert.rejects(
          independent.rate('login-account', 'limited@example.invalid', 5, 900_000),
          /Too many/,
        );
        for (let n = 0; n < 13; n++) {
          assert.equal(
            (
              await client.request('/auth/login', {
                email: 'different-' + n + '@example.invalid',
                password: 'incorrect',
              })
            ).status,
            401,
          );
        }
        assert.equal(
          (
            await client.request('/auth/login', {
              email: 'another@example.invalid',
              password: 'incorrect',
            })
          ).status,
          429,
        );
        for (let n = 0; n < 3; n++)
          assert.equal(
            (
              await client.request('/auth/forgot-password', {
                email: 'reset-limit@example.invalid',
              })
            ).status,
            202,
          );
        assert.equal(
          (await client.request('/auth/forgot-password', { email: 'reset-limit@example.invalid' }))
            .status,
          429,
        );
        for (let n = 0; n < 7; n++)
          await client.request('/auth/forgot-password', {
            email: 'unique-' + n + '@example.invalid',
          });
        assert.equal(
          (await client.request('/auth/forgot-password', { email: 'other@example.invalid' }))
            .status,
          429,
        );
      },
    );
    await suite.test(
      'production cookies are Secure/__Host; API responses never expose traces, SQL or tokens',
      async () => {
        tickWindow();
        const prod = await AuthService.create(
          repository,
          {
            ...config,
            secure: true,
            cookieName: '__Host-livora_session',
            origin: 'https://community.example',
          },
          auth.mailer,
          queue,
          () => now,
        );
        const secureServer = createApp(prod, log, '127.0.0.1')
          .set('env', 'production')
          .listen(0, '127.0.0.1');
        await once(secureServer, 'listening');
        const secureAddress = secureServer.address();
        assert.ok(secureAddress && typeof secureAddress !== 'string');
        const browser = new AuthClient(
          'http://127.0.0.1:' + secureAddress.port,
          'https://community.example',
        );
        try {
          assert.equal((await browser.request('/auth/csrf')).status, 400);
          const response = await browser.request('/auth/csrf', undefined, {
            'X-Forwarded-Proto': 'https',
          });
          assert.equal(response.status, 200);
          assert.match(response.headers.get('set-cookie') ?? '', /^__Host-livora_session=/);
          for (const flag of ['; Path=/', '; HttpOnly', '; Secure', '; SameSite=Lax'])
            assert.ok(response.headers.get('set-cookie')?.includes(flag));
          assert.equal(response.headers.get('set-cookie')?.includes('Domain='), false);
          assert.equal(response.headers.get('cache-control'), 'no-store');
          const forwarded = { 'X-Forwarded-Proto': 'https' };
          assert.equal(
            (
              await browser.request(
                '/auth/login',
                { email: 'platform@example.invalid', password },
                forwarded,
              )
            ).status,
            200,
          );
          const identity = repository.identity.bind(repository);
          repository.identity = () =>
            Promise.reject(new Error('SELECT private password_hash STACK C:\\private'));
          try {
            const failed = await browser.request('/auth/session', undefined, forwarded);
            assert.equal(failed.status, 500);
            assert.equal(failed.headers.get('cache-control'), 'no-store');
            assert.equal(/SELECT|password_hash|STACK|private|stack|trace/.test(failed.raw), false);
          } finally {
            repository.identity = identity;
          }
        } finally {
          await new Promise<void>((resolve, reject) =>
            secureServer.close((error) => (error ? reject(error) : resolve())),
          );
        }
        tickWindow();
        await client.login('platform@example.invalid', password);
        const original = repository.identity.bind(repository);
        repository.identity = () =>
          Promise.reject(new Error('SELECT private password_hash STACK C:\\private'));
        try {
          const failed = await client.request('/auth/session');
          assert.equal(failed.status, 500);
          assert.equal(failed.headers.get('cache-control'), 'no-store');
          assert.equal(/SELECT|password_hash|STACK|private|stack|trace/.test(failed.raw), false);
        } finally {
          repository.identity = original;
        }
      },
    );
    await suite.test(
      'auth audits cannot be updated/deleted; session and reset FKs reject missing users',
      async () => {
        await assert.rejects(db.execute('UPDATE auth_events SET action = action'), /immutable/);
        await assert.rejects(db.execute('DELETE FROM auth_events'), /immutable/);
        await assert.rejects(
          db.execute(
            "INSERT INTO platform_user_roles (user_id, role_code) VALUES (9999999, 'PLATFORM_ADMIN')",
          ),
        );
        await assert.rejects(
          db.execute(
            "INSERT INTO platform_user_roles (user_id, role_code) VALUES (?, 'RESIDENT')",
            [user.user],
          ),
        );
        assert.ok(safeLogs.every((code) => /^[A-Z_]+$/.test(code)));
      },
    );
  } finally {
    await queue.idle();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await database.pool.end();
  }
}
