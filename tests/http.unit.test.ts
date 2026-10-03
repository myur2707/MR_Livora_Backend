import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { ApiError, errorHandler } from '../src/http/errors.js';

void test('HTTP errors distinguish invalid input from internal failures without leaking details', async () => {
  const app = express();
  const logs: string[] = [];
  app.use((_request, response, next) => {
    response.locals['requestId'] = 'synthetic-correlation';
    next();
  });
  app.use(express.json({ limit: 100 }));
  app.post('/json', (_request, response) => {
    response.sendStatus(204);
  });
  app.get('/syntax', () => {
    throw new SyntaxError('private path and SQL');
  });
  app.get('/object-code', () => {
    throw Object.assign(new Error('private internal failure'), {
      code: {
        toString: () => {
          throw new Error('unsafe coercion');
        },
      },
    });
  });
  app.get('/constraint/:code', (request) => {
    throw Object.assign(new Error('private database failure'), {
      code: request.params['code'],
      sql: 'private SQL',
      sqlMessage: 'private identity',
    });
  });
  app.get('/limit', () => {
    throw new ApiError(429, 'RATE_LIMITED', 'Please try again later.', 7);
  });
  app.use(errorHandler((code, id) => logs.push(code + ':' + id)));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = 'http://127.0.0.1:' + address.port;
  async function check(path: string, status: number, options?: RequestInit) {
    const response = await fetch(base + path, options);
    assert.equal(response.status, status);
    const body = await response.text();
    assert.ok(body.includes('synthetic-correlation'));
    assert.doesNotMatch(body, /private|unsafe coercion|stack|sqlMessage/);
    return response;
  }
  try {
    await check('/json', 400, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    await check('/json', 413, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'x'.repeat(200) }),
    });
    await check('/syntax', 500);
    await check('/object-code', 500);
    for (const code of [
      'ER_DUP_ENTRY',
      'ER_LOCK_DEADLOCK',
      'ER_LOCK_WAIT_TIMEOUT',
      'ER_SIGNAL_EXCEPTION',
      'ER_NO_REFERENCED_ROW_2',
      'ER_ROW_IS_REFERENCED_2',
      'ER_CHECK_CONSTRAINT_VIOLATED',
    ])
      await check('/constraint/' + code, 409);
    await check('/constraint/ER_ACCESS_DENIED_ERROR', 500);
    assert.equal((await check('/limit', 429)).headers.get('Retry-After'), '7');
    assert.deepEqual(logs, Array<string>(3).fill('REQUEST_FAILED:synthetic-correlation'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

void test('production error responses and structured logs omit request credentials and SQL details', async () => {
  const app = express();
  app.set('env', 'production');
  const markers = {
    password: 'synthetic-password-marker',
    token: 'synthetic-token-marker',
    secret: 'synthetic-secret-marker',
  };
  const logs: string[] = [];
  app.use(express.json());
  app.use((_request, response, next) => {
    response.locals['requestId'] = 'production-error-probe';
    next();
  });
  app.post('/failure', () => {
    throw Object.assign(new Error('SELECT private credentials ' + JSON.stringify(markers)), {
      code: 'ER_ACCESS_DENIED_ERROR',
      sql: 'SELECT password_hash FROM users',
      path: 'C:\\private\\database',
    });
  });
  app.use(errorHandler((code, requestId) => logs.push(JSON.stringify({ code, requestId }))));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const response = await fetch('http://127.0.0.1:' + address.port + '/failure', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'fixture=' + markers.token,
        Authorization: 'Bearer ' + markers.secret,
      },
      body: JSON.stringify(markers),
    });
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.deepEqual(JSON.parse(body), {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Unable to complete this request.',
        requestId: 'production-error-probe',
      },
    });
    assert.deepEqual(logs, [
      JSON.stringify({ code: 'REQUEST_FAILED', requestId: 'production-error-probe' }),
    ]);
    for (const marker of Object.values(markers)) {
      assert.equal(body.includes(marker), false);
      assert.equal(logs.join('\n').includes(marker), false);
    }
    assert.doesNotMatch(body + logs.join('\n'), /SELECT|password_hash|stack|sql|C:\\private/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
