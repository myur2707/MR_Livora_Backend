import type { Request, RequestHandler, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { AuthService } from '../auth/service.js';
import type { AuthIdentity, Permission, Session } from '../auth/types.js';
import { equalToken } from '../auth/crypto.js';
import { ApiError } from './errors.js';

interface Context {
  token: string;
  session: Session;
  identity: AuthIdentity | null;
}
export class Security {
  private readonly contexts = new WeakMap<Request, Context>();
  constructor(readonly auth: AuthService) {}
  readonly headers: RequestHandler = async (request, response, next) => {
    response.locals['requestId'] = randomUUID();
    response.set({
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    if (this.auth.config.secure) {
      response.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      if (!request.secure) throw new ApiError(400, 'HTTPS_REQUIRED', 'HTTPS is required.');
    }
    if (request.get('sec-fetch-site') === 'cross-site')
      throw new ApiError(403, 'ORIGIN_REJECTED', 'Request origin is not allowed.');
    const propertyList =
      /^\/society\/(?:buildings|flats|persons|imports)$/.test(request.path) ||
      /^\/society\/(?:flats\/[1-9][0-9]*\/occupancies|imports\/[1-9][0-9]*\/rows)$/.test(
        request.path,
      );
    const paginated =
      propertyList ||
      /^\/society\/resident\/(?:flats|bills|payments|receipts|notices|complaints)$/.test(
        request.path,
      ) ||
      /^\/society\/billing\/payments(?:\/(?:report|collectors|payers|report-collectors))?$/.test(
        request.path,
      ) ||
      /^\/society\/billing\/(?:charge-types|configurations|periods|buildings|flats|bills|outstanding)$/.test(
        request.path,
      ) ||
      [
        '/resident-access/requests',
        '/society/resident-invitations',
        '/society/registration-requests',
      ].includes(request.path) ||
      request.path === '/platform/societies' ||
      /^\/(?:platform|onboarding)\/societies\/[1-9][0-9]*\/structure$/.test(request.path) ||
      /^\/onboarding\/societies\/[1-9][0-9]*\/(?:residents|maintenance)$/.test(request.path);
    if (Object.keys(request.query).length > 0 && !paginated)
      throw new ApiError(400, 'INVALID_REQUEST', 'Query parameters are not supported.');
    await this.auth.rate('api-ip', request.ip ?? 'unknown', 120, 60_000);
    next();
  };
  rawToken(request: Request): string | null {
    const name = this.auth.config.cookieName;
    const matches = (request.get('cookie') ?? '')
      .split(';')
      .map((v) => v.trim())
      .filter((v) => v.startsWith(name + '='));
    if (matches.length !== 1) return null;
    const value = matches[0]?.slice(name.length + 1);
    return value && /^[a-zA-Z0-9_-]{43}$/.test(value) ? value : null;
  }
  cookie(response: Response, token: string): void {
    response.cookie(this.auth.config.cookieName, token, {
      httpOnly: true,
      secure: this.auth.config.secure,
      sameSite: 'lax',
      path: '/',
      maxAge: this.auth.config.absoluteMs,
    });
  }
  clearCookie(response: Response): void {
    response.clearCookie(this.auth.config.cookieName, {
      httpOnly: true,
      secure: this.auth.config.secure,
      sameSite: 'lax',
      path: '/',
    });
  }
  readonly load: RequestHandler = async (request, _response, next) => {
    const token = this.rawToken(request);
    if (token) {
      const session = await this.auth.readSession(token);
      if (session) {
        const identity = await this.auth.repository.identity(session);
        if (session.userId && !identity)
          await this.auth.repository.revoke(session.hash, this.auth.clock());
        else this.contexts.set(request, { token, session, identity });
      }
    }
    next();
  };
  context(request: Request): Context {
    const value = this.contexts.get(request);
    if (!value) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    return value;
  }
  identity(request: Request): AuthIdentity {
    const identity = this.context(request).identity;
    if (!identity) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    return identity;
  }
  readonly authenticated: RequestHandler = (request, _response, next) => {
    this.identity(request);
    next();
  };
  readonly csrf: RequestHandler = (request, _response, next) => {
    if (request.get('origin') !== this.auth.config.origin)
      throw new ApiError(403, 'ORIGIN_REJECTED', 'Request origin is not allowed.');
    const context = this.contexts.get(request);
    const supplied = request.get('x-csrf-token') ?? '';
    if (!context || !equalToken(this.auth.csrf(context.token), supplied))
      throw new ApiError(403, 'CSRF_INVALID', 'Refresh this page and try again.');
    if (!request.is('application/json'))
      throw new ApiError(415, 'JSON_REQUIRED', 'Use JSON for this request.');
    next();
  };
  readonly platform: RequestHandler = (request, _response, next) => {
    if (!this.identity(request).platformAdmin)
      throw new ApiError(403, 'ACCESS_DENIED', 'Access is not permitted.');
    next();
  };
  tenant(permission: Permission): RequestHandler {
    return (request, _response, next) => {
      const membership = this.identity(request).activeSociety;
      if (!membership || !membership.permissions.includes(permission))
        throw new ApiError(403, 'ACCESS_DENIED', 'Access is not permitted.');
      next();
    };
  }
}
