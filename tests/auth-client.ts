import assert from 'node:assert/strict';

export class AuthClient {
  cookie = '';
  csrf = '';
  constructor(
    readonly base: string,
    readonly origin: string,
  ) {}
  async request(path: string, body?: unknown, extra: Record<string, string> = {}) {
    const response = await fetch(this.base + '/api/v1' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...(body === undefined
          ? {}
          : { Origin: this.origin, 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf }),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const cookie = response.headers.get('set-cookie');
    if (cookie !== null) this.cookie = cookie.split(';')[0] ?? '';
    const raw = await response.text();
    const parsed: unknown = raw.startsWith('{') ? JSON.parse(raw) : {};
    assert.ok(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed));
    const data = parsed as Record<string, unknown>;
    if (typeof data['csrfToken'] === 'string') this.csrf = data['csrfToken'];
    return { status: response.status, data, headers: response.headers, raw };
  }
  async bootstrap(): Promise<void> {
    assert.equal((await this.request('/auth/csrf')).status, 200);
  }
  async login(email: string, password: string): Promise<void> {
    await this.bootstrap();
    assert.equal((await this.request('/auth/login', { email, password })).status, 200);
  }
}
