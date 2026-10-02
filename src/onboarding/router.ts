import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Security } from '../http/security.js';
import type { OnboardingService } from './service.js';
import type { InvitationService } from './invitations.js';
import {
  parse,
  identifier,
  createSocietySchema,
  pageSchema,
  residentPageSchema,
  inviteSchema,
  transitionSchema,
  buildingSchema,
  residentSchema,
  maintenanceSchema,
  confirmationSchema,
  acceptSchema,
  inspectSchema,
} from './contracts.js';
export function onboardingRouter(
  security: Security,
  onboarding: OnboardingService,
  invitations: InvitationService,
) {
  const router = Router();
  const session = (r: Request) => security.context(r).session;
  const audit = (r: Request, s: Response) =>
    security.auth.audit(r.ip ?? 'unknown', String(s.locals['requestId']));
  const id = (r: Request) => parse(identifier, r.params['id']);
  router.get('/platform/dashboard', security.authenticated, security.platform, async (r, s) =>
    s.json(await onboarding.repository.dashboard(session(r))),
  );
  router.get('/platform/societies', security.authenticated, security.platform, async (r, s) =>
    s.json(await onboarding.repository.list(session(r), parse(pageSchema, r.query))),
  );
  router.post(
    '/platform/societies',
    security.csrf,
    security.authenticated,
    security.platform,
    async (r, s) =>
      s
        .status(201)
        .json(await onboarding.create(session(r), parse(createSocietySchema, r.body), audit(r, s))),
  );
  for (const scope of ['platform', 'committee'] as const) {
    const prefix = scope === 'platform' ? '/platform/societies/:id' : '/onboarding/societies/:id';
    const guards =
      scope === 'platform' ? [security.authenticated, security.platform] : [security.authenticated];
    router.get(prefix, ...guards, async (r, s) =>
      s.json(await onboarding.detail(session(r), id(r), scope)),
    );
    router.get(prefix + '/structure', ...guards, async (r, s) =>
      s.json(
        await onboarding.structure(
          session(r),
          id(r),
          scope,
          parse(residentPageSchema, r.query).page,
        ),
      ),
    );
    router.post(prefix + '/buildings', security.csrf, ...guards, async (r, s) => {
      await onboarding.building(
        session(r),
        id(r),
        scope,
        parse(buildingSchema, r.body),
        audit(r, s),
      );
      s.status(201).end();
    });
  }
  router.post(
    '/platform/societies/:id/status',
    security.csrf,
    security.authenticated,
    security.platform,
    async (r, s) => {
      const body = parse(transitionSchema, r.body);
      await onboarding.transition(
        session(r),
        id(r),
        body.revision,
        body.status,
        body.fromStatus,
        audit(r, s),
      );
      s.sendStatus(204);
    },
  );
  router.post(
    '/platform/societies/:id/committee-invitations',
    security.csrf,
    security.authenticated,
    security.platform,
    async (r, s) => {
      const body = parse(inviteSchema, r.body);
      await security.auth.rate(
        'committee-invite',
        security.identity(r).userId + ':' + id(r),
        5,
        900000,
      );
      await invitations.invite(
        session(r),
        id(r),
        body.revision,
        body.email,
        body.displayName,
        audit(r, s),
      );
      s.status(202).json({ message: 'Invitation queued. Check its delivery status.' });
    },
  );
  router.post('/onboarding/invitations/inspect', security.csrf, async (r, s) => {
    await security.auth.rate('invite-inspect-ip', r.ip ?? 'unknown', 30, 900000);
    s.json(await invitations.inspect(parse(inspectSchema, r.body).token));
  });
  router.post('/onboarding/invitations/accept', security.csrf, async (r, s) => {
    await security.auth.rate('invite-accept-ip', r.ip ?? 'unknown', 10, 900000);
    const body = parse(acceptSchema, r.body);
    await invitations.accept(security.context(r).session, body.token, body.password, audit(r, s));
    s.sendStatus(204);
  });
  router.get('/onboarding/societies/:id/residents', security.authenticated, async (r, s) => {
    const page = parse(residentPageSchema, r.query);
    s.json(await onboarding.residents(session(r), id(r), page.page));
  });
  router.post(
    '/onboarding/societies/:id/residents',
    security.csrf,
    security.authenticated,
    async (r, s) => {
      await onboarding.resident(session(r), id(r), parse(residentSchema, r.body), audit(r, s));
      s.status(201).end();
    },
  );
  router.get('/onboarding/societies/:id/maintenance', security.authenticated, async (r, s) =>
    s.json(
      await onboarding.configurations(session(r), id(r), parse(residentPageSchema, r.query).page),
    ),
  );
  router.post(
    '/onboarding/societies/:id/maintenance',
    security.csrf,
    security.authenticated,
    async (r, s) => {
      await onboarding.maintenance(
        session(r),
        id(r),
        parse(maintenanceSchema, r.body),
        audit(r, s),
      );
      s.status(201).end();
    },
  );
  for (const section of ['residents', 'maintenance', 'review', 'activate'] as const) {
    router.post(
      '/onboarding/societies/:id/' + section + '/confirm',
      security.csrf,
      security.authenticated,
      async (r, s) => {
        const body = parse(confirmationSchema, r.body);
        const context = audit(r, s);
        if (section === 'review')
          await onboarding.review(session(r), id(r), body.revision, context);
        else if (section === 'activate')
          await onboarding.activate(session(r), id(r), body.revision, context);
        else await onboarding.confirm(session(r), id(r), body.revision, section, context);
        s.sendStatus(204);
      },
    );
  }
  return router;
}
