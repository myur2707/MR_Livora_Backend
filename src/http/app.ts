import express from 'express';
import { propertyRouter, type PropertyModule } from '../property/router.js';
import { z } from 'zod';
import type { AuthService } from '../auth/service.js';
import { ApiError, errorHandler } from './errors.js';
import type { SafeLogger } from './errors.js';
import { Security } from './security.js';
import { onboardingRouter } from '../onboarding/router.js';
import type { OnboardingService } from '../onboarding/service.js';
import type { InvitationService } from '../onboarding/invitations.js';
import { residentAccessRouter, type ResidentAccessModule } from '../resident-access/router.js';
import { billingRouter, type BillingModule } from '../billing/router.js';
import { paymentRouter, type PaymentModule } from '../payments/router.js';
import { residentPortalRouter, type ResidentPortalModule } from '../resident-portal/router.js';
import { communityRouter, type CommunityModule } from '../community/router.js';
import { reportsRouter, type ReportsModule } from '../reports/router.js';

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email())
  .refine((v) => /^[\x20-\x7e]+$/.test(v));
const password = z.string().min(15).max(128);
const token = z.string().regex(/^[a-zA-Z0-9_-]{43}$/);
const id = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/)
  .refine((v) => BigInt(v) <= 18446744073709551615n);
const loginSchema = z.strictObject({ email, password: z.string().min(1).max(128) });
const forgotSchema = z.strictObject({ email });
const resetSchema = z.strictObject({ token, password });
const selectionSchema = z.strictObject({ societyId: id.nullable() });
const emptySchema = z.strictObject({});
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new ApiError(400, 'INVALID_REQUEST', 'Check the request fields and try again.');
  return result.data;
}
export function createApp(
  auth: AuthService,
  log: SafeLogger,
  trustedProxy?: string,
  onboarding?: { service: OnboardingService; invitations: InvitationService },
  property?: PropertyModule,
  residentAccess?: ResidentAccessModule,
  billing?: BillingModule,
  payments?: PaymentModule,
  residentPortal?: ResidentPortalModule,
  community?: CommunityModule,
  reports?: ReportsModule,
) {
  const app = express();
  const security = new Security(auth);
  app.disable('x-powered-by');
  if (trustedProxy) app.set('trust proxy', trustedProxy);
  app.use('/api/v1', security.headers, security.load);
  if (property)
    app.post(
      '/api/v1/society/imports/preview',
      security.authenticated,
      security.tenant('society.members.manage'),
      express.json({ limit: '400kb', strict: true }),
      (_request, _response, next) => next(),
    );
  app.use('/api/v1', express.json({ limit: '16kb', strict: true }));
  const router = express.Router();
  router.get('/auth/csrf', async (request, response) => {
    let raw = security.rawToken(request);
    if (!raw || !(await auth.readSession(raw))) {
      raw = await auth.anonymous();
      security.cookie(response, raw);
    }
    response.json({ csrfToken: auth.csrf(raw) });
  });
  router.post('/auth/login', security.csrf, async (request, response) => {
    await auth.rate('login-ip', request.ip ?? 'unknown', 20, 900_000);
    const body = parse(loginSchema, request.body);
    await auth.rate('login-account', body.email, 5, 900_000);
    const raw = await auth.login(
      security.context(request).session,
      body.email,
      body.password,
      auth.audit(request.ip ?? 'unknown', String(response.locals['requestId'])),
    );
    security.cookie(response, raw);
    response.json({ csrfToken: auth.csrf(raw) });
  });
  router.get('/auth/session', security.authenticated, (request, response) => {
    response.json({
      ...security.identity(request),
      expiresAt: security.context(request).session.absoluteExpiresAt.replace(' ', 'T') + 'Z',
    });
  });
  router.post('/auth/logout', security.csrf, async (request, response) => {
    parse(emptySchema, request.body);
    await auth.logout(
      security.context(request).session,
      auth.audit(request.ip ?? 'unknown', String(response.locals['requestId'])),
    );
    security.clearCookie(response);
    response.sendStatus(204);
  });
  router.post('/auth/forgot-password', security.csrf, async (request, response) => {
    await auth.rate('reset-request-ip', request.ip ?? 'unknown', 10, 900_000);
    const body = parse(forgotSchema, request.body);
    await auth.rate('reset-request-account', body.email, 3, 900_000);
    auth.requestReset(
      body.email,
      auth.audit(request.ip ?? 'unknown', String(response.locals['requestId'])),
    );
    response
      .status(202)
      .json({ message: 'If this account is eligible, a reset link will be sent.' });
  });
  router.post('/auth/reset-password', security.csrf, async (request, response) => {
    await auth.rate('reset-submit-ip', request.ip ?? 'unknown', 10, 900_000);
    const body = parse(resetSchema, request.body);
    await auth.rate('reset-submit-token', body.token, 5, 900_000);
    await auth.resetPassword(
      body.token,
      body.password,
      auth.audit(request.ip ?? 'unknown', String(response.locals['requestId'])),
    );
    security.clearCookie(response);
    response.sendStatus(204);
  });
  router.post(
    '/auth/society-context',
    security.csrf,
    security.authenticated,
    async (request, response) => {
      const body = parse(selectionSchema, request.body);
      const identity = security.identity(request);
      if (
        body.societyId !== null &&
        !identity.memberships.some((m) => m.societyId === body.societyId)
      )
        throw new ApiError(403, 'ACCESS_DENIED', 'Access is not permitted.');
      if (
        !(await auth.repository.selectSociety(
          security.context(request).session,
          body.societyId,
          auth.audit(request.ip ?? 'unknown', String(response.locals['requestId'])),
          auth.clock(),
        ))
      )
        throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
      response.sendStatus(204);
    },
  );
  // These return authorization context only. No private/business resource endpoints in Step 3.
  router.get('/platform/access', security.authenticated, security.platform, (_request, response) =>
    response.json({ role: 'PLATFORM_ADMIN' }),
  );
  router.get(
    '/society/access',
    security.authenticated,
    security.tenant('society.dashboard.read'),
    (request, response) => response.json(security.identity(request).activeSociety),
  );
  app.use('/api/v1', router);
  if (onboarding)
    app.use('/api/v1', onboardingRouter(security, onboarding.service, onboarding.invitations));
  if (residentAccess) app.use('/api/v1', residentAccessRouter(security, residentAccess));
  if (residentPortal)
    app.use('/api/v1/society/resident', residentPortalRouter(security, residentPortal));
  if (community) app.use('/api/v1/society/community', communityRouter(security, community));
  if (reports) app.use('/api/v1', reportsRouter(security, reports));
  if (payments) app.use('/api/v1', paymentRouter(security, payments));
  if (billing) app.use('/api/v1', billingRouter(security, billing));
  if (property) app.use('/api/v1', propertyRouter(security, property));
  app.use(() => {
    throw new ApiError(404, 'NOT_FOUND', 'Resource not found.');
  });
  app.use(errorHandler(log));
  return app;
}
