import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hashPassword,
  verifyPassword,
  newToken,
  tokenHash,
  csrfToken,
  equalToken,
} from '../src/auth/crypto.js';
import { loadConfig } from '../src/auth/config.js';
import { roleCapabilities } from '../src/auth/types.js';

void test('Argon2id hashes use independent salts and the reviewed work factors', async () => {
  const password = 'A synthetic password for tests';
  const a = await hashPassword(password);
  const b = await hashPassword(password);
  assert.match(a, /^\$argon2id\$v=19\$/);
  assert.deepEqual(a.split('$')[3]?.split(',').sort(), ['m=19456', 'p=1', 't=2']);
  assert.notEqual(a, b);
  assert.ok(await verifyPassword(a, password));
  assert.equal(await verifyPassword(a, 'wrong password'), false);
  assert.equal(await verifyPassword('corrupt', password), false);
});
void test('opaque tokens are unpredictable; CSRF tokens bind to their session and server secret', () => {
  const a = newToken();
  const b = newToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  assert.equal(tokenHash(a).length, 32);
  assert.notEqual(tokenHash(a).toString('hex'), a);
  assert.notEqual(csrfToken('secret-a', a), csrfToken('secret-a', b));
  assert.notEqual(csrfToken('secret-a', a), csrfToken('secret-b', a));
  assert.ok(equalToken('equal', 'equal'));
  assert.equal(equalToken('equal', 'short'), false);
});
void test('production configuration rejects insecure origins and placeholder secrets', () => {
  const env = {
    NODE_ENV: 'production',
    APP_ORIGIN: 'https://community.example',
    AUTH_SECRET: 'a'.repeat(64),
    SMTP_HOST: 'smtp.example',
    SMTP_USER: 'fixture',
    SMTP_PASSWORD: 'fixture',
    SMTP_FROM: 'sender@example.invalid',
  };
  assert.equal(loadConfig(env).auth.cookieName, '__Host-livora_session');
  assert.ok(loadConfig(env).auth.secure);
  for (const patch of [
    { APP_ORIGIN: 'http://community.example' },
    { APP_ORIGIN: 'https://community.example/path' },
    { AUTH_SECRET: 'replace_with_secret' },
  ])
    assert.throws(() => loadConfig({ ...env, ...patch }));
  assert.throws(() =>
    loadConfig({ ...env, NODE_ENV: 'development', APP_ORIGIN: 'https://public.example' }),
  );
  assert.throws(() =>
    loadConfig({ ...env, NODE_ENV: 'development', APP_ORIGIN: 'ftp://127.0.0.1' }),
  );
});
void test('role ceilings prevent financial privileges for residents, members and platform roles', () => {
  assert.deepEqual(roleCapabilities.RESIDENT, ['society.dashboard.read']);
  assert.deepEqual(roleCapabilities.COMMITTEE_MEMBER, [
    'society.dashboard.manage',
    'society.dashboard.read',
    'society.notices.manage',
    'society.complaints.manage',
  ]);
  for (const role of ['RESIDENT', 'COMMITTEE_MEMBER'] as const)
    assert.ok(
      roleCapabilities[role].every((permission) => !permission.startsWith('society.finance.')),
    );
  assert.ok(roleCapabilities.ACCOUNTANT.includes('society.finance.record'));
  assert.ok(roleCapabilities.COMMITTEE_ADMIN.includes('society.members.manage'));
  assert.equal('PLATFORM_ADMIN' in roleCapabilities, false);
});
